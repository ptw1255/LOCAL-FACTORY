import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import type { RunRecord } from '../domain/types.js';
import { EventService } from '../observability/event-service.js';
import { JsonStore } from '../storage/json-store.js';
import { LocalWorkflowExecutor } from './executor.js';
import { compareRuns, ReplayNotDeterministicError, WorkflowReplayService } from './replay.js';

async function waitFor(store: JsonStore, runId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = await store.read((state) => state.runs.find((run) => run.id === runId)?.status);
    if (status === 'succeeded' || status === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for replay fixture run.');
}

describe('WorkflowReplayService', () => {
  it('reports deterministic path-level semantic differences without retaining payloads', () => {
    const base = { unitOutputs: { normalize: { status: 'ok', items: [{ id: 1, value: 'stable' }] } }, completedNodeIds: ['trigger', 'normalize'] } as unknown as RunRecord;
    const changed = { unitOutputs: { normalize: { status: 'ok', items: [{ id: 1, value: 'changed' }, { id: 2, value: 'new' }] } }, completedNodeIds: ['trigger', 'normalize'] } as unknown as RunRecord;
    expect(compareRuns(base, changed)).toEqual([
      'unitOutputs.normalize.items.length differs: expected 1, received 2.',
      'unitOutputs.normalize.items[0].value differs.',
      'unitOutputs.normalize.items[1] is missing from source.',
    ]);
  });

  it('replays the pinned deterministic definition and compares outputs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-replay-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const executor = new LocalWorkflowExecutor(store, events);
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-replay';
    workflow.version = 7;
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'normalize', type: 'code', label: 'Normalize', position: { x: 160, y: 0 }, config: { operation: 'uppercase', value: 'stable' }, unit: defaultWorkUnit('code') },
    ];
    workflow.edges = [{ id: 'trigger-normalize', source: 'trigger', target: 'normalize' }];
    const source = await executor.start(workflow);
    await waitFor(store, source.id);
    const replay = await new WorkflowReplayService(store, executor).replay(source.id);

    expect(replay).toMatchObject({ sourceRunId: source.id, workflowId: workflow.id, workflowVersion: 7, status: 'passed', differences: [], id: expect.stringMatching(/^replay-report-/), sourceOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/), replayOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await store.read((state) => state.replayReports)).toEqual([expect.objectContaining({ id: replay.id, replayRunId: replay.replayRunId })]);
    const replayRun = await store.read((state) => state.runs.find((run) => run.id === replay.replayRunId));
    expect(replayRun).toEqual(expect.objectContaining({ replayOfRunId: source.id, workflowVersion: 7 }));
  });

  it('rejects workflows whose pinned definition includes nondeterministic nodes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-replay-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const events = new EventService(store);
    const executor = new LocalWorkflowExecutor(store, events);
    const source = await executor.start(seedWorkflow);
    await waitFor(store, source.id);

    await expect(new WorkflowReplayService(store, executor).replay(source.id)).rejects.toBeInstanceOf(ReplayNotDeterministicError);
  });
});
