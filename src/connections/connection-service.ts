import { randomUUID } from 'node:crypto';

import type { ConnectionRecord } from '../domain/types.js';
import type { PlatformStore } from '../storage/store.js';
import type { SecretBroker } from './secret-broker.js';
import { connectionAlias } from './connection-secret-broker.js';

export interface CreateConnectionInput {
  tenantId: string;
  projectId: string;
  name: string;
  connector: string;
  environment: string;
  scopes: string[];
  secret?: string;
}

export interface SetConnectionSecretInput {
  tenantId: string;
  /** Omit for a reusable FACTORY-level Connection. */
  projectId?: string;
  name: string;
  connector: string;
  secret: string;
}

export class ConnectionService {
  public constructor(
    private readonly store: PlatformStore,
    private readonly secrets?: SecretBroker,
  ) {}

  public list(projectId?: string, tenantId?: string): Promise<ConnectionRecord[]> {
    return this.store.read((state) => state.connections.filter(
      (connection) =>
        (projectId === undefined || connection.projectId === projectId) &&
        (tenantId === undefined || connection.tenantId === tenantId),
    ));
  }

  /**
   * The FACTORY Connections surface includes reusable tenant Connections and
   * legacy Project records so existing local health information stays visible.
   */
  public listFactory(tenantId?: string): Promise<ConnectionRecord[]> {
    return this.store.read((state) => state.connections.filter(
      (connection) => tenantId === undefined || connection.tenantId === tenantId,
    ));
  }

  public async create(input: CreateConnectionInput): Promise<ConnectionRecord> {
    const connectionId = randomUUID();
    const connection: ConnectionRecord = {
      tenantId: input.tenantId,
      projectId: input.projectId,
      id: connectionId,
      name: input.name,
      connector: input.connector,
      environment: input.environment,
      scopes: input.scopes,
      status: 'healthy',
      lastCheckedAt: new Date().toISOString(),
      usageCount: 0,
      secretConfigured: input.secret !== undefined,
      ...(input.secret === undefined ? {} : { secretRef: `connections/${connectionId}` }),
    };
    if (input.secret !== undefined && this.secrets === undefined) {
      throw new Error('A configured Vault secret broker is required to store credentials.');
    }
    await this.store.mutate((state) => {
      const duplicate = state.connections.some(
        (candidate) =>
          candidate.name.toLowerCase() === connection.name.toLowerCase() &&
          candidate.environment === connection.environment,
      );
      if (duplicate) {
        throw new Error(
          `Connection "${connection.name}" already exists in ${connection.environment}.`,
        );
      }
      if (input.secret !== undefined && connection.secretRef !== undefined) {
        return this.secrets!.put(connection.secretRef, input.secret).then(() => {
          state.connections.push(connection);
        });
      }
      state.connections.push(connection);
    });
    return connection;
  }

  public async check(connectionId: string, projectId?: string, tenantId?: string): Promise<ConnectionRecord> {
    return this.store.mutate((state) => {
      const connection = state.connections.find(
        (candidate) => candidate.id === connectionId,
      );
      if (
        connection === undefined ||
        (projectId !== undefined && connection.projectId !== projectId) ||
        (tenantId !== undefined && connection.tenantId !== tenantId)
      ) {
        throw new Error('Connection not found.');
      }
      connection.status = 'healthy';
      connection.lastCheckedAt = new Date().toISOString();
      return connection;
    });
  }

  public async setSecret(input: SetConnectionSecretInput): Promise<ConnectionRecord> {
    if (this.secrets === undefined) throw new Error('Local secrets are unavailable. Start FACTORY with its secrets service enabled.');
    const alias = connectionAlias(input.name);
    if (alias === '') throw new Error('Connection name must contain letters or numbers.');
    const secretRef = input.projectId === undefined
      ? `tenants/${input.tenantId}/connections/${alias}`
      : `projects/${input.projectId}/connections/${alias}`;
    await this.secrets.put(secretRef, input.secret);
    return this.store.mutate((state) => {
      const existing = state.connections.find((candidate) => candidate.tenantId === input.tenantId && candidate.projectId === input.projectId && candidate.factoryScoped === (input.projectId === undefined) && connectionAlias(candidate.name) === alias);
      if (existing !== undefined) {
        existing.connector = input.connector;
        existing.secretRef = secretRef;
        existing.secretConfigured = true;
        existing.status = 'healthy';
        existing.lastCheckedAt = new Date().toISOString();
        return existing;
      }
      const connection: ConnectionRecord = {
        tenantId: input.tenantId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.projectId === undefined ? { factoryScoped: true } : {}),
        id: randomUUID(),
        name: alias,
        connector: input.connector,
        environment: 'local',
        scopes: ['models:invoke'],
        status: 'healthy',
        lastCheckedAt: new Date().toISOString(),
        usageCount: 0,
        secretRef,
        secretConfigured: true,
      };
      state.connections.push(connection);
      return connection;
    });
  }

  public async testSecret(name: string, projectId: string | undefined, tenantId: string): Promise<ConnectionRecord> {
    if (this.secrets === undefined) throw new Error('Local secrets are unavailable. Start FACTORY with its secrets service enabled.');
    const alias = connectionAlias(name);
    const connection = await this.store.read((state) => state.connections.find((candidate) => candidate.tenantId === tenantId && candidate.projectId === projectId && connectionAlias(candidate.name) === alias)
      ?? (projectId === undefined ? state.connections.find((candidate) => candidate.tenantId === tenantId && connectionAlias(candidate.name) === alias) : undefined));
    if (connection === undefined || connection.secretConfigured !== true || connection.secretRef === undefined) throw new Error(`Connection "${alias}" has no stored secret.`);
    await this.secrets.get(connection.secretRef);
    return this.store.mutate((state) => {
      const current = state.connections.find((candidate) => candidate.id === connection.id);
      if (current === undefined) throw new Error('Connection not found.');
      current.status = 'healthy';
      current.lastCheckedAt = new Date().toISOString();
      return current;
    });
  }

  public async removeSecret(name: string, projectId: string | undefined, tenantId: string): Promise<void> {
    if (this.secrets === undefined || this.secrets.delete === undefined) throw new Error('Configured secret storage does not support deletion.');
    const alias = connectionAlias(name);
    const connection = await this.store.read((state) => state.connections.find((candidate) => candidate.tenantId === tenantId && candidate.projectId === projectId && connectionAlias(candidate.name) === alias)
      ?? (projectId === undefined ? state.connections.find((candidate) => candidate.tenantId === tenantId && connectionAlias(candidate.name) === alias) : undefined));
    if (connection === undefined) throw new Error(`Connection "${alias}" was not found in FACTORY Local.`);
    if (connection.secretRef !== undefined) await this.secrets.delete(connection.secretRef);
    await this.store.mutate((state) => {
      state.connections = state.connections.filter((candidate) => candidate.id !== connection.id);
    });
  }
}
