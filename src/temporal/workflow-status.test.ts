import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';

const temporal = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const statuses: unknown[] = [];
  const fail = { value: false };
  const activity = vi.fn(async (input: { nodeId: string }) => {
    if (fail.value) throw new Error('activity failed');
    return { nodeId: input.nodeId, result: 'ok', lifecycle: { spanId: `span-${input.nodeId}` } };
  });
  return { handlers, statuses, fail, activity };
});

vi.mock('@temporalio/workflow', () => ({
  condition: async (predicate: () => boolean) => {
    if (!predicate()) throw new Error('test condition was not ready');
  },
  defineSignal: (name: string) => name,
  proxyActivities: () => ({
    executeNodeActivity: temporal.activity,
    executeNodeSideEffectActivity: temporal.activity,
    executeAgentIterationActivity: temporal.activity,
    executeAgentToolActivity: temporal.activity,
  }),
  setHandler: (signal: string, handler: (...args: unknown[]) => void) => {
    temporal.handlers.set(signal, handler);
  },
  upsertSearchAttributes: (attributes: unknown) => {
    temporal.statuses.push(attributes);
  },
}));

describe('Temporal workflow status search attributes', () => {
  let executeWorkflow: typeof import('./workflows.js').executeWorkflow;

  beforeAll(async () => {
    ({ executeWorkflow } = await import('./workflows.js'));
  });

  beforeEach(() => {
    temporal.statuses.length = 0;
    temporal.handlers.clear();
    temporal.fail.value = false;
    temporal.activity.mockClear();
  });

  function singleNodeDefinition() {
    const definition = structuredClone(seedWorkflow);
    const trigger = definition.nodes.find((node) => node.type === definition.trigger.type);
    if (trigger === undefined) throw new Error('Seed trigger is missing.');
    definition.nodes = [trigger];
    definition.edges = [];
    definition.agents = [];
    return definition;
  }

  it('updates Temporal status from running to succeeded', async () => {
    const result = await executeWorkflow({ runId: 'workflow-status-success', definition: singleNodeDefinition() });

    expect(result.completedNodeIds).toHaveLength(1);
    expect(temporal.statuses).toEqual([{ Status: ['running'] }, { Status: ['succeeded'] }]);
  });

  it('updates Temporal status to failed when an activity fails', async () => {
    temporal.fail.value = true;

    await expect(executeWorkflow({ runId: 'workflow-status-failure', definition: singleNodeDefinition() })).rejects.toThrow('activity failed');
    expect(temporal.statuses).toEqual([{ Status: ['running'] }, { Status: ['failed'] }]);
  });
});
