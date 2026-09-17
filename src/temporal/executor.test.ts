import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { EventService } from '../observability/event-service.js';
import { JsonStore } from '../storage/json-store.js';
import type { TemporalWorkflowResult } from './workflows.js';
import { TemporalWorkflowExecutor, type TemporalWorkflowClientLike, type TemporalWorkflowHandleLike } from './executor.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function waitFor(store: JsonStore, runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await store.read((state) => state.runs.find((run) => run.id === runId)?.status) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Temporal test run did not reach ${status}.`);
}

class FakeHandle implements TemporalWorkflowHandleLike {
  public readonly firstExecutionRunId = 'temporal-run-1';
  public readonly resultDeferred = deferred<TemporalWorkflowResult>();
  public readonly cancel = vi.fn(async () => undefined);
  public readonly signal = vi.fn(async () => undefined);
  public workflowId: string;
  public constructor(workflowId: string) { this.workflowId = workflowId; }
  public result(): Promise<TemporalWorkflowResult> { return this.resultDeferred.promise; }
}

describe('TemporalWorkflowExecutor', () => {
  it('pins a run to a versioned Temporal queue and recovers its result', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-executor-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const handle = new FakeHandle('factory-run');
    const start = vi.fn(async (_type: string, options: { workflowId: string; taskQueue: string; args: unknown[]; searchAttributes: Record<string, string[]>; memo: Record<string, unknown> }) => {
      handle.workflowId = options.workflowId;
      return handle;
    });
    const client: TemporalWorkflowClientLike = {
      workflow: {
        start,
        getHandle: vi.fn(() => handle),
      },
    };
    const executor = new TemporalWorkflowExecutor({ store, events, client, taskQueuePrefix: 'factory-workflows' });
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-temporal-test';
    workflow.version = 3;
    const run = await executor.start(workflow, { artifactId: 'sha256:release' });
    expect(run).toEqual(expect.objectContaining({ executionEngine: 'temporal', status: 'running', artifactId: 'sha256:release', releaseBundleHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), pinnedAgentVersions: expect.any(Object), temporalWorkflowId: `factory-${run.id}`, temporalTaskQueue: 'factory-workflows-v3', temporalRunId: 'temporal-run-1' }));
    expect(start).toHaveBeenCalledWith('executeWorkflow', expect.objectContaining({ workflowId: `factory-${run.id}`, taskQueue: 'factory-workflows-v3', searchAttributes: expect.objectContaining({ WorkflowId: [workflow.id], WorkflowVersion: ['3'], CorrelationId: [run.traceId], ReleaseBundle: [run.releaseBundleHash], AgentVersions: [JSON.stringify(run.pinnedAgentVersions)] }) }));

    handle.resultDeferred.resolve({ completedNodeIds: ['trigger', 'prepare'], unitOutputs: { prepare: 'ok' }, lifecycle: [] });
    await waitFor(store, run.id, 'succeeded');
    expect(await store.read((state) => state.runs.find((candidate) => candidate.id === run.id))).toEqual(expect.objectContaining({ completedNodeIds: ['trigger', 'prepare'], unitOutputs: { prepare: 'ok' } }));

    const recovered = await executor.recover();
    expect(recovered).toBe(0);
  });

  it('reattaches persisted Temporal runs after a process restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-recover-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const handle = new FakeHandle('factory-recover');
    const getHandle = vi.fn(() => handle);
    const client: TemporalWorkflowClientLike = { workflow: { start: vi.fn(), getHandle } };
    const run = {
      id: 'temporal-persisted-run', workflowId: seedWorkflow.id, workflowName: seedWorkflow.name, workflowVersion: seedWorkflow.version,
      executionEngine: 'temporal' as const, temporalWorkflowId: 'factory-temporal-persisted-run', temporalRunId: 'temporal-recovered-1', temporalTaskQueue: 'agentic-workflows-v1',
      traceId: '0123456789abcdef0123456789abcdef', status: 'running' as const, startedAt: new Date().toISOString(), costUsd: 0, humanTouchpoints: 0,
      workflowDefinition: structuredClone(seedWorkflow), completedNodeIds: [], activatedNodeIds: ['trigger'], approvedNodeIds: [], approvedNodeHashes: {}, pendingApprovalHashes: {}, unitOutputs: {}, ciCheckpoints: {},
    };
    await store.mutate((state) => { state.runs.push(run); });
    const executor = new TemporalWorkflowExecutor({ store, events, client });
    expect(await executor.recover()).toBe(1);
    expect(getHandle).toHaveBeenCalledWith('factory-temporal-persisted-run', 'temporal-recovered-1');
    handle.resultDeferred.resolve({ completedNodeIds: ['trigger'], unitOutputs: {}, lifecycle: [] });
    await waitFor(store, run.id, 'succeeded');
    expect((await events.list(run.id)).some((event) => event.type === 'run.recovered')).toBe(true);
  });

  it('cancels a Temporal handle and records the terminal operator action', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-cancel-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const handle = new FakeHandle('factory-cancel');
    const client: TemporalWorkflowClientLike = { workflow: { start: vi.fn(async () => handle), getHandle: vi.fn(() => handle) } };
    const executor = new TemporalWorkflowExecutor({ store, events, client });
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-temporal-cancel';
    const run = await executor.start(workflow);
    const cancelled = await executor.cancel(run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(handle.cancel).toHaveBeenCalledOnce();
    expect((await events.list(run.id)).some((event) => event.type === 'run.cancelled')).toBe(true);
  });

  it('retries a terminal Temporal run with pinned provenance', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-retry-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const handle = new FakeHandle('factory-retry');
    const start = vi.fn(async () => handle);
    const client: TemporalWorkflowClientLike = { workflow: { start, getHandle: vi.fn(() => handle) } };
    const executor = new TemporalWorkflowExecutor({ store, events, client });
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-temporal-retry';
    const failed = await executor.start(workflow, { input: { retryable: true }, artifactId: 'sha256:retry-artifact' });
    await store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === failed.id);
      if (run === undefined) throw new Error('Run missing.');
      run.status = 'failed';
      run.error = 'transient failure';
    });
    const retried = await executor.retry(failed.id, { idempotencyKey: 'temporal-retry-1' });
    expect(retried).toEqual(expect.objectContaining({ replayOfRunId: failed.id, artifactId: 'sha256:retry-artifact', input: { retryable: true }, retryIdempotencyKey: 'temporal-retry-1', executionEngine: 'temporal' }));
    const repeated = await executor.retry(failed.id, { idempotencyKey: 'temporal-retry-1' });
    expect(repeated.id).toBe(retried.id);
    expect(start).toHaveBeenCalledTimes(2);
    expect((await events.list(failed.id)).some((event) => event.type === 'run.retried' && event.attributes?.['run.retry_id'] === retried.id)).toBe(true);
  });

  it('records approval denial as one failed decision after cancelling the handle', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-deny-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const handle = new FakeHandle('factory-deny');
    const client: TemporalWorkflowClientLike = { workflow: { start: vi.fn(async () => handle), getHandle: vi.fn(() => handle) } };
    const executor = new TemporalWorkflowExecutor({ store, events, client });
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-temporal-deny';
    const run = await executor.start(workflow);
    const denied = await executor.deny(run.id, { reason: 'Risk review rejected the action.' });
    expect(denied).toEqual(expect.objectContaining({ status: 'failed', error: 'Risk review rejected the action.' }));
    expect(handle.cancel).toHaveBeenCalledOnce();
    const terminalEvents = (await events.list(run.id)).filter((event) => ['run.cancelled', 'run.failed'].includes(event.type));
    expect(terminalEvents.map((event) => event.type)).toEqual(['run.failed']);
  });

  it('records a correlated approval event and ignores repeated approval delivery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-approve-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const handle = new FakeHandle('factory-approve');
    const client: TemporalWorkflowClientLike = { workflow: { start: vi.fn(async () => handle), getHandle: vi.fn(() => handle) } };
    const executor = new TemporalWorkflowExecutor({ store, events, client });
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-temporal-approve';
    const approval = workflow.nodes.find((candidate) => candidate.id === 'prepare');
    if (approval === undefined) throw new Error('Prepare node is missing.');
    approval.type = 'approval';
    approval.unit = { kind: 'human', version: 1, inputSchema: 'any', outputSchema: 'any', timeoutMs: 60_000, retryAttempts: 1, idempotencyKey: 'approval:v1' };
    const run = await executor.start(workflow);

    await executor.approve(run.id);
    await executor.approve(run.id);

    expect(handle.signal).toHaveBeenCalledOnce();
    const approved = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id));
    expect(approved?.approvedNodeIds).toEqual(['prepare']);
    expect((await events.list(run.id)).filter((event) => event.type === 'approval.received')).toHaveLength(1);
  });
});
