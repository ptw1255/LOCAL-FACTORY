import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonStore } from '../storage/json-store.js';
import { PlatformTemporalObservabilitySink, type TemporalActivityLifecycle } from './observability.js';

function lifecycle(overrides: Partial<TemporalActivityLifecycle> = {}): TemporalActivityLifecycle {
  return {
    runId: 'run-temporal',
    tenantId: 'tenant-local',
    projectId: 'project-local',
    nodeId: 'normalize',
    nodeType: 'code',
    unitKind: 'deterministic',
    unitVersion: 1,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    sequence: 2,
    attempt: 1,
    idempotencyKey: 'run-temporal:temporal:normalize:2',
    status: 'succeeded',
    occurredAt: '2026-09-16T19:00:00.000Z',
    durationMs: 12,
    inputHash: 'c'.repeat(64),
    outputHash: 'd'.repeat(64),
    ...overrides,
  };
}

describe('PlatformTemporalObservabilitySink', () => {
  it('persists correlated evidence and telemetry with retry-safe IDs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-observability-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const sink = new PlatformTemporalObservabilitySink(store);
    const record = lifecycle();

    await sink.record(record);
    await sink.record(record);

    const evidence = await store.listEvidence(record.runId);
    const events = await store.listEvents(record.runId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(expect.objectContaining({
      tenantId: record.tenantId,
      projectId: record.projectId,
      source: 'temporal-activity',
      status: 'succeeded',
      inputHash: record.inputHash,
      outputHash: record.outputHash,
      correlationId: record.traceId,
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'unit.succeeded',
      signal: 'trace',
      traceId: record.traceId,
      spanId: record.spanId,
      attributes: expect.objectContaining({
        'runtime.engine': 'temporal',
        'run.id': record.runId,
        'unit.id': record.nodeId,
      }),
    }));
  });

  it('retains bounded failure details without storing payloads', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-observability-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const sink = new PlatformTemporalObservabilitySink(store);
    await sink.record(lifecycle({ status: 'failed', error: 'x'.repeat(3_000), outputHash: undefined }));

    const evidence = await store.listEvidence('run-temporal');
    const events = await store.listEvents('run-temporal');
    expect(evidence[0]?.error).toHaveLength(2_000);
    expect(events[0]?.data).toEqual({ error: 'x'.repeat(2_000) });
    expect(JSON.stringify(evidence)).not.toContain('payload');
  });

  it('keeps distinct retry attempts while deduplicating duplicate delivery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-observability-retries-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const sink = new PlatformTemporalObservabilitySink(store);
    const first = lifecycle({ attempt: 1 });
    const retry = lifecycle({ attempt: 2, spanId: 'c'.repeat(16), occurredAt: '2026-09-16T19:00:01.000Z' });

    await sink.record(first);
    await sink.record(first);
    await sink.record(retry);
    await sink.record(retry);

    expect(await store.listEvidence(first.runId)).toHaveLength(2);
    expect(await store.listEvents(first.runId)).toHaveLength(2);
    expect((await store.listEvidence(first.runId)).map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it('persists parent span relationships for nested Temporal activities', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-observability-parent-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const sink = new PlatformTemporalObservabilitySink(store);
    await sink.record(lifecycle({ nodeId: 'parent', spanId: 'p'.repeat(16) }));
    await sink.record(lifecycle({ nodeId: 'child', spanId: 'c'.repeat(16), parentSpanId: 'p'.repeat(16), idempotencyKey: 'run-temporal:temporal:child:3' }));

    const events = await store.listEvents('run-temporal');
    expect(events.find((event) => event.nodeId === 'child')).toEqual(expect.objectContaining({ parentSpanId: 'p'.repeat(16) }));
  });

  it('links workflow and agent release identity into Temporal evidence and telemetry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-observability-release-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const sink = new PlatformTemporalObservabilitySink(store);
    await sink.record(lifecycle({ workflowId: 'workflow-release', workflowVersion: 4, releaseBundleHash: 'sha256:release', pinnedAgentVersions: { planner: 2 } }));
    const evidence = (await store.listEvidence('run-temporal'))[0];
    const event = (await store.listEvents('run-temporal'))[0];
    expect(evidence?.metadata).toEqual(expect.objectContaining({ 'workflow.id': 'workflow-release', 'workflow.version': 4, 'release.bundle.hash': 'sha256:release', 'agent.versions': JSON.stringify({ planner: 2 }) }));
    expect(event?.attributes).toEqual(expect.objectContaining({ 'workflow.id': 'workflow-release', 'workflow.version': 4, 'release.bundle.hash': 'sha256:release' }));
  });
});
