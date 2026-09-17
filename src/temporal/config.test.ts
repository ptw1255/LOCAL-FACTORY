import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { temporalConnectionSettings, temporalTaskQueues } from './config.js';

describe('Temporal connection settings', () => {
  it('resolves one versioned queue by default and bounded explicit queues for rollout', () => {
    expect(temporalTaskQueues({ TEMPORAL_TASK_QUEUE_PREFIX: 'factory', TEMPORAL_WORKFLOW_VERSION: '7' })).toEqual(['factory-v7']);
    expect(temporalTaskQueues({ TEMPORAL_TASK_QUEUE: 'factory-custom' })).toEqual(['factory-custom']);
    expect(temporalTaskQueues({ TEMPORAL_TASK_QUEUES: 'factory-v1, factory-v2, factory-v1' })).toEqual(['factory-v1', 'factory-v2']);
  });

  it('keeps local defaults while accepting a Temporal API key', () => {
    expect(temporalConnectionSettings({ TEMPORAL_API_KEY: '  temporal-secret  ' })).toEqual({ address: 'localhost:7233', namespace: 'default', apiKey: 'temporal-secret' });
  });

  it('loads production mTLS material from files without exposing it in settings metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-tls-'));
    const certFile = path.join(directory, 'client.crt');
    const keyFile = path.join(directory, 'client.key');
    const caFile = path.join(directory, 'ca.crt');
    await writeFile(certFile, 'client-cert');
    await writeFile(keyFile, 'client-key');
    await writeFile(caFile, 'root-ca');

    expect(temporalConnectionSettings({ TEMPORAL_ADDRESS: 'temporal.example:7233', TEMPORAL_NAMESPACE: 'production', TEMPORAL_TLS_CERT_FILE: certFile, TEMPORAL_TLS_KEY_FILE: keyFile, TEMPORAL_TLS_CA_FILE: caFile, TEMPORAL_TLS_SERVER_NAME: 'temporal.example' })).toEqual({
      address: 'temporal.example:7233',
      namespace: 'production',
      tls: { clientCertPair: { crt: Buffer.from('client-cert'), key: Buffer.from('client-key') }, serverRootCACertificate: Buffer.from('root-ca'), serverNameOverride: 'temporal.example' },
    });
  });

  it('rejects partial client certificate configuration', () => {
    expect(() => temporalConnectionSettings({ TEMPORAL_TLS_CERT_FILE: '/missing/client.crt' })).toThrow('CERT_FILE and TEMPORAL_TLS_KEY_FILE');
  });
});
