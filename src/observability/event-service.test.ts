import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunEvent, RunRecord } from '../domain/types.js';
import { seedWorkflow } from '../domain/seed.js';
import { JsonStore } from '../storage/json-store.js';
import { FileArtifactStore } from '../storage/artifact-store.js';
import { EventService } from './event-service.js';
import { validSpanContext, withOtelSpanContext } from './otel-context.js';

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

async function waitForNextMillisecond(timestamp: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const wait = (): void => {
      if (Date.now() > Date.parse(timestamp)) {
        resolve();
        return;
      }
      setTimeout(wait, 1);
    };
    wait();
  });
}

describe('EventService retention', () => {
  it('inherits immutable run release context on every emitted signal', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const run: RunRecord = {
      tenantId: 'tenant-local',
      projectId: 'project-local',
      id: 'run-context',
      workflowId: seedWorkflow.id,
      workflowName: seedWorkflow.name,
      workflowVersion: 7,
      releaseBundleHash: 'sha256:release-context',
      pinnedAgentVersions: { planner: 3 },
      artifactId: 'sha256:artifact-context',
      environment: 'staging',
      deploymentId: 'deployment-context',
      traceId: 'a'.repeat(32),
      status: 'running',
      startedAt: new Date().toISOString(),
      costUsd: 0,
      humanTouchpoints: 0,
      workflowDefinition: structuredClone(seedWorkflow),
      completedNodeIds: [],
      activatedNodeIds: [],
      approvedNodeIds: [],
      approvedNodeHashes: {},
      pendingApprovalHashes: {},
      unitOutputs: {},
      ciCheckpoints: {},
    };
    await store.mutate((state) => { state.runs.push(run); });
    const service = new EventService(store);

    const emitted = await service.emit(run.id, 'unit.started', 'started', { nodeId: 'planner', signal: 'trace' });

    expect(emitted.attributes).toEqual(expect.objectContaining({
      'workflow.id': seedWorkflow.id,
      'workflow.version': 7,
      'release.bundle.hash': 'sha256:release-context',
      'agent.versions': JSON.stringify({ planner: 3 }),
      'artifact.id': 'sha256:artifact-context',
      'deployment.id': 'deployment-context',
      'deployment.environment': 'staging',
    }));
  });

  it('inherits immutable run release context on durable operation evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const run: RunRecord = {
      tenantId: 'tenant-local',
      projectId: 'project-local',
      id: 'run-evidence-context',
      workflowId: seedWorkflow.id,
      workflowName: seedWorkflow.name,
      workflowVersion: 4,
      releaseBundleHash: 'sha256:evidence-release',
      pinnedAgentVersions: { reviewer: 2 },
      artifactId: 'sha256:evidence-artifact',
      environment: 'production',
      deploymentId: 'deployment-evidence',
      traceId: 'b'.repeat(32),
      status: 'running',
      startedAt: new Date().toISOString(),
      costUsd: 0,
      humanTouchpoints: 0,
      workflowDefinition: structuredClone(seedWorkflow),
      completedNodeIds: [],
      activatedNodeIds: [],
      approvedNodeIds: [],
      approvedNodeHashes: {},
      pendingApprovalHashes: {},
      unitOutputs: {},
      ciCheckpoints: {},
    };
    await store.mutate((state) => { state.runs.push(run); });

    const evidence = await new EventService(store).recordEvidence({
      runId: run.id,
      unitId: 'repository-mutation',
      operation: 'repositoryMutation',
      status: 'succeeded',
      metadata: { 'repository.revision': 'abc123' },
    });

    expect(evidence.metadata).toEqual(expect.objectContaining({
      'repository.revision': 'abc123',
      'workflow.id': seedWorkflow.id,
      'workflow.version': 4,
      'release.bundle.hash': 'sha256:evidence-release',
      'agent.versions': JSON.stringify({ reviewer: 2 }),
      'artifact.id': 'sha256:evidence-artifact',
      'deployment.id': 'deployment-evidence',
      'deployment.environment': 'production',
    }));
  });

  it('offloads oversized event payloads and resolves them on demand', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const artifacts = new FileArtifactStore(path.join(directory, 'artifacts'));
    const service = new EventService(store, { artifactStore: artifacts, inlineDataBytes: 1_024 });
    const payload = { output: 'x'.repeat(2_000) };

    const emitted = await service.emit('run-1', 'unit.completed', 'completed', { data: payload });
    expect(emitted.data).toEqual(expect.objectContaining({ artifactRef: expect.objectContaining({ id: expect.stringMatching(/^artifact:sha256:/) }) }));
    expect(JSON.stringify(emitted)).not.toContain(payload.output);
    await expect(service.resolvePayload(emitted.data)).resolves.toEqual(payload);
  });

  it('adds standard correlation attributes to every emitted signal', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const service = new EventService(new JsonStore(path.join(directory, 'state.json')));

    const emitted = await service.emit('run-1', 'unit.completed', 'completed', {
      nodeId: 'unit-1',
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      attributes: { 'deployment.id': 'deployment-1' },
    });

    expect(emitted.attributes).toEqual(expect.objectContaining({
      'run.id': 'run-1',
      'trace.id': emitted.traceId,
      'span.id': emitted.spanId,
      'unit.id': 'unit-1',
      'deployment.id': 'deployment-1',
    }));
  });

  it('links node events into parent-child spans when no explicit parent is supplied', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const service = new EventService(new JsonStore(path.join(directory, 'state.json')));
    const started = await service.emit('run-1', 'unit.started', 'started', { nodeId: 'unit-1', signal: 'trace' });
    const completed = await service.emit('run-1', 'unit.completed', 'completed', { nodeId: 'unit-1', signal: 'trace' });
    expect(completed.parentSpanId).toBe(started.spanId);
    expect(completed.traceId).toBe(started.traceId);
  });

  it('inherits the official OpenTelemetry async parent context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const service = new EventService(new JsonStore(path.join(directory, 'state.json')));
    const traceId = 'c'.repeat(32);
    const parentSpanId = 'd'.repeat(16);
    const emitted = await withOtelSpanContext(validSpanContext(traceId, parentSpanId), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return service.emit('run-otel-context', 'unit.completed', 'completed', { signal: 'trace' });
    });
    expect(emitted.traceId).toBe(traceId);
    expect(emitted.parentSpanId).toBe(parentSpanId);
    expect(emitted.spanId).not.toBe(parentSpanId);
  });

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
    const started = await service.recordEvidence({ runId: 'run-1', unitId: 'check', operation: 'repositoryCheck', status: 'started', metadata: { tenant: 'local' } });
    // Keep the exact-range assertion deterministic even on fast filesystems where
    // consecutive writes can otherwise share the same millisecond timestamp.
    await waitForNextMillisecond(started.occurredAt);
    const terminal = await service.recordEvidence({ runId: 'run-1', unitId: 'check', operation: 'repositoryCheck', status: 'succeeded' });
    await waitForNextMillisecond(terminal.occurredAt);
    await service.recordEvidence({ runId: 'run-1', unitId: 'patch', operation: 'repositoryPatch', status: 'succeeded' });
    expect(await service.listEvidence({ unitId: 'check', operation: 'repositoryCheck', status: 'succeeded' })).toEqual([terminal]);
    expect(await service.listEvidence({ from: terminal.occurredAt, to: terminal.occurredAt })).toEqual([terminal]);
  });

  it('queries durable evidence by repository revision and pull request metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new EventService(store);
    await service.recordEvidence({ runId: 'run-1', unitId: 'commit', operation: 'repositoryCommit', status: 'succeeded', metadata: { 'repository.name': 'example/repo', 'repository.revision': 'abc123' } });
    await service.recordEvidence({ runId: 'run-1', unitId: 'pr', operation: 'repositoryPullRequest', status: 'succeeded', metadata: { 'repository.name': 'example/repo', 'pull_request.number': 42 } });
    expect((await service.listEvidence({ repository: 'example/repo', commit: 'abc123' })).map((entry) => entry.unitId)).toEqual(['commit']);
    expect((await service.listEvidence({ repository: 'example/repo', pullRequest: '42' })).map((entry) => entry.unitId)).toEqual(['pr']);
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

  it('redacts sensitive metadata keys and bounds retained values', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-events-'));
    const service = new EventService(new JsonStore(path.join(directory, 'state.json')));
    const evidence = await service.recordEvidence({
      runId: 'run-1', unitId: 'provider', operation: 'llm', status: 'succeeded',
      metadata: { 'provider.request_id': 'req-1', 'api.key': 'super-secret', prompt: 'do not retain', detail: 'x'.repeat(600) },
    });
    expect(evidence.metadata).toEqual({ 'provider.request_id': 'req-1', detail: 'x'.repeat(500) });
    expect(JSON.stringify(await service.listEvidence('run-1'))).not.toContain('super-secret');
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
