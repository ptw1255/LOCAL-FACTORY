import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonStore } from './json-store.js';
import { seedWorkflow } from '../domain/seed.js';
import type { RunEvent, RunRecord } from '../domain/types.js';

describe('JsonStore', () => {
  it('seeds and persists state atomically', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-store-'));
    const file = path.join(directory, 'state.json');
    const store = new JsonStore(file);

    const workflowCount = await store.read((state) => state.workflows.length);
    await store.mutate((state) => {
      state.connections[0]!.usageCount += 1;
    });

    expect(workflowCount).toBe(1);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      connections: Array<{ usageCount: number }>;
    };
    expect(persisted.connections[0]?.usageCount).toBe(1);
  });

  it('serializes concurrent cold reads and mutations', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-store-'));
    const file = path.join(directory, 'state.json');
    const store = new JsonStore(file);

    await Promise.all([
      ...Array.from({ length: 10 }, () =>
        store.read((state) => state.workflows.length),
      ),
      ...Array.from({ length: 10 }, () =>
        store.mutate((state) => {
          state.connections[0]!.usageCount += 1;
        }),
      ),
    ]);

    const usageCount = await store.read(
      (state) => state.connections[0]?.usageCount,
    );
    expect(usageCount).toBe(10);
  });

  it('migrates state files that predate workflow version history', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-store-'));
    const file = path.join(directory, 'state.json');
    const state = {
      workflows: [{ id: 'workflow-1', version: 3 }],
      runs: [],
      events: [],
      connections: [],
      proposals: [],
    };
    await writeFile(file, JSON.stringify(state), 'utf8');

    const store = new JsonStore(file);
    const versions = await store.read((loaded) => loaded.workflowVersions);

    expect(versions).toEqual([{
      id: 'workflow-1',
      version: 3,
      agents: [],
      tenantId: 'tenant-local',
      projectId: 'project-local',
    }]);
  });

  it('supports the shared observability persistence contract', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-store-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const event: RunEvent = {
      id: '11111111-1111-4111-8111-111111111111',
      runId: 'run-1',
      type: 'run.started',
      timestamp: new Date().toISOString(),
      message: 'started',
      signal: 'log',
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
    };

    await store.appendEvent(event);

    expect(await store.listEvents('run-1')).toEqual([event]);
  });

  it('commits a terminal state and lifecycle event together', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-store-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const runId = 'run-atomic';
    const run: RunRecord = {
      id: runId,
      workflowId: seedWorkflow.id,
      workflowName: seedWorkflow.name,
      workflowVersion: seedWorkflow.version,
      traceId: '0123456789abcdef0123456789abcdef',
      status: 'running',
      startedAt: new Date().toISOString(),
      costUsd: 0,
      humanTouchpoints: 0,
      workflowDefinition: structuredClone(seedWorkflow),
      completedNodeIds: [],
      activatedNodeIds: ['trigger'],
      approvedNodeIds: [],
      approvedNodeHashes: {},
      pendingApprovalHashes: {},
      unitOutputs: {},
      ciCheckpoints: {},
    };
    await store.mutate((state) => { state.runs.push(run); });
    const event: RunEvent = {
      id: '22222222-2222-4222-8222-222222222222',
      runId,
      type: 'run.timed_out',
      timestamp: new Date().toISOString(),
      message: 'timed out',
      signal: 'log',
      traceId: run.traceId,
      spanId: '2222222222222222',
    };
    const result = await store.mutateAndAppendEvent(async (state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target !== undefined) target.status = 'timed_out';
      return { value: target?.status, event } } );

    expect(result).toEqual({ value: 'timed_out', eventAppended: true });
    expect(await store.read((state) => state.runs.find((candidate) => candidate.id === runId)?.status)).toBe('timed_out');
    expect(await store.listEvents(runId)).toEqual([event]);
  });
});
