import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConnectionSecretBroker } from './connection-secret-broker.js';
import { JsonStore } from '../storage/json-store.js';
import { createSeedState } from '../domain/seed.js';

describe('ConnectionSecretBroker', () => {
  it('resolves a Connection alias only inside the selected Project', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-connection-secret-')), 'state.json'));
    await store.mutate((state) => {
      Object.assign(state, createSeedState());
      state.connections.push({
        id: 'connection-typesafe-ai', tenantId: 'tenant-local', projectId: 'project-local', name: 'typesafe-ai', connector: 'openai-compatible', environment: 'local', scopes: ['models:invoke'], status: 'healthy', lastCheckedAt: new Date().toISOString(), usageCount: 0, secretRef: 'projects/project-local/connections/typesafe-ai', secretConfigured: true,
      });
    });
    const reads: string[] = [];
    const broker = new ConnectionSecretBroker(store, {
      put: async () => undefined,
      get: async (reference) => { reads.push(reference); return 'local-secret'; },
    });

    await expect(broker.get('Connection/TypeSafe AI', { tenantId: 'tenant-local', projectId: 'project-local' })).resolves.toBe('local-secret');
    await expect(broker.get('Connection/typesafe-ai', { tenantId: 'tenant-local', projectId: 'other-project' })).rejects.toThrow('not configured');
    expect(reads).toEqual(['projects/project-local/connections/typesafe-ai']);
  });

  it('resolves a FACTORY-level Connection from any Project in its tenant', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-global-connection-secret-')), 'state.json'));
    await store.mutate((state) => {
      Object.assign(state, createSeedState());
      state.connections.push({
        id: 'connection-shared', tenantId: 'tenant-local', factoryScoped: true, name: 'shared-key', connector: 'openai-compatible', environment: 'local', scopes: ['models:invoke'], status: 'healthy', lastCheckedAt: new Date().toISOString(), usageCount: 0, secretRef: 'tenants/tenant-local/connections/shared-key', secretConfigured: true,
      });
    });
    const broker = new ConnectionSecretBroker(store, {
      put: async () => undefined,
      get: async (reference) => reference,
    });

    await expect(broker.get('Connection/shared-key', { tenantId: 'tenant-local', projectId: 'another-project' })).resolves.toBe('tenants/tenant-local/connections/shared-key');
  });
});
