import type { PlatformStore } from '../storage/store.js';
import type { SecretBroker, SecretScope } from './secret-broker.js';

const connectionPrefix = 'Connection/';

export function connectionAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Resolves declarative Connection/name references to the project-scoped Vault
 * reference held by connection metadata. Raw Vault references remain supported
 * for compatibility with existing YAML.
 */
export class ConnectionSecretBroker implements SecretBroker {
  public constructor(
    private readonly store: PlatformStore,
    private readonly vault: SecretBroker,
  ) {}

  public put(reference: string, value: string): Promise<void> {
    return this.vault.put(reference, value);
  }

  public delete(reference: string): Promise<void> {
    if (this.vault.delete === undefined) throw new Error('Configured secret storage does not support deletion.');
    return this.vault.delete(reference);
  }

  public async get(reference: string, scope: SecretScope = {}): Promise<string> {
    if (!reference.startsWith(connectionPrefix)) return this.vault.get(reference);
    if (scope.projectId === undefined || scope.projectId === '') throw new Error(`Secret reference "${reference}" requires a Project context.`);
    const requestedAlias = connectionAlias(reference.slice(connectionPrefix.length));
    if (requestedAlias === '') throw new Error('Connection secret reference is invalid.');
    const connection = await this.store.read((state) => {
      const inTenant = (candidate: { tenantId?: string; name: string }) =>
        (scope.tenantId === undefined || candidate.tenantId === scope.tenantId)
        && connectionAlias(candidate.name) === requestedAlias;
      // FACTORY-level Connections are reusable by every Project in the tenant.
      // Keep the Project-scoped lookup only as a migration fallback.
      return state.connections.find((candidate) => candidate.factoryScoped === true && inTenant(candidate))
        ?? state.connections.find((candidate) => candidate.projectId === scope.projectId && inTenant(candidate));
    });
    if (connection === undefined) throw new Error(`Connection "${requestedAlias}" is not configured for this Project.`);
    if (connection.secretConfigured !== true || connection.secretRef === undefined) throw new Error(`Connection "${requestedAlias}" has no stored secret.`);
    return this.vault.get(connection.secretRef);
  }
}
