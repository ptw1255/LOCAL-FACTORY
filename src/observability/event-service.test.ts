import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunEvent } from '../domain/types.js';
import { JsonStore } from '../storage/json-store.js';
import { EventService } from './event-service.js';

function event(id: string, timestamp: string, traceId: string): RunEvent {
  return {
    id,
    runId: 'run-1',
    type: 'run.started',
    timestamp,
    message: 'started',
    signal: 'trace',
    traceId,
    spanId: id.replaceAll('-', '').slice(0, 16),
  };
}

describe('EventService retention', () => {
  it('removes events older than the configured window', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new EventService(store, { retentionHours: 48 });
    const now = Date.now();

    await store.appendEvent(event(
      '11111111-1111-4111-8111-111111111111',
      new Date(now - 49 * 60 * 60 * 1000).toISOString(),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ));
    await store.appendEvent(event(
      '22222222-2222-4222-8222-222222222222',
      new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ));

    expect(await service.prune()).toBe(1);
    expect((await service.list()).map((item) => item.traceId)).toEqual([
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('does not let an exporter failure interrupt event persistence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const exporter = {
      export: async () => {
        throw new Error('collector unavailable');
      },
    };
    const service = new EventService(store, { exporter });

    await expect(service.emit('run-1', 'run.started', 'started')).resolves.toEqual(
      expect.objectContaining({ type: 'run.started' }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(await service.list('run-1')).toHaveLength(1);
  });

  it('persists redacted operation evidence independently of telemetry retention', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new EventService(store);

    const evidence = await service.recordEvidence({
      runId: 'run-1',
      unitId: 'repository-check',
      operation: 'repositoryCheck',
      status: 'succeeded',
      input: { command: 'npm test', secret: 'must-not-be-stored' },
      output: { exitCode: 0 },
      metadata: { attempt: 1 },
    });

    expect(evidence.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await service.listEvidence('run-1'))).not.toContain('must-not-be-stored');
    expect(await service.listEvidence('run-1')).toEqual([evidence]);
  });

  it('queries durable evidence by unit, operation, status, and time window', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new EventService(store);
    await service.recordEvidence({ runId: 'run-1', unitId: 'check', operation: 'repositoryCheck', status: 'started', metadata: { tenant: 'local' } });
    const terminal = await service.recordEvidence({ runId: 'run-1', unitId: 'check', operation: 'repositoryCheck', status: 'succeeded' });
    await service.recordEvidence({ runId: 'run-1', unitId: 'patch', operation: 'repositoryPatch', status: 'succeeded' });
    expect(await service.listEvidence({ unitId: 'check', operation: 'repositoryCheck', status: 'succeeded' })).toEqual([terminal]);
    expect(await service.listEvidence({ from: terminal.occurredAt, to: terminal.occurredAt })).toEqual([terminal]);
  });

  it('derives stable evidence identity for retry-safe lifecycle writes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new EventService(store);
    const first = await service.recordEvidence({ runId: 'run-1', unitId: 'commit', operation: 'repositoryCommit', status: 'started', idempotencyKey: 'commit-attempt-1', correlationId: 'trace-1' });
    const retry = await service.recordEvidence({ runId: 'run-1', unitId: 'commit', operation: 'repositoryCommit', status: 'started', idempotencyKey: 'commit-attempt-1', correlationId: 'trace-1' });
    expect(retry.id).toBe(first.id);
    expect(await service.listEvidence('run-1')).toHaveLength(1);
    expect(first.idempotencyKey).toBe('commit-attempt-1');
    expect(first).toEqual(expect.objectContaining({ actor: 'runtime', source: 'local-executor', correlationId: 'trace-1' }));
  });

  it('prunes durable evidence only when its separate policy is configured', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new EventService(store, { retentionHours: 48, evidenceRetentionHours: 1 });
    const old = await service.recordEvidence({ runId: 'run-1', unitId: 'old', operation: 'repositoryCheck', status: 'succeeded' });
    await store.mutate((state) => { const entry = state.evidence.find((candidate) => candidate.id === old.id); if (entry !== undefined) entry.occurredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); });
    await service.recordEvidence({ runId: 'run-1', unitId: 'new', operation: 'repositoryCheck', status: 'succeeded' });
    expect(await service.prune()).toBe(1);
    expect((await service.listEvidence('run-1')).map((entry) => entry.unitId)).toEqual(['new']);
  });
});
