import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';

const temporal = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const statuses: unknown[] = [];
  const calls: string[] = [];
  const results = new Map<string, unknown>();
  const failOn = new Set<string>();
  const fail = { value: false };
  const activity = vi.fn(async (input: { nodeId: string }) => {
    calls.push(input.nodeId);
    if (fail.value || failOn.has(input.nodeId)) throw new Error('activity failed');
    return { nodeId: input.nodeId, result: results.get(input.nodeId) ?? 'ok', lifecycle: { spanId: `span-${input.nodeId}` } };
  });
  return { handlers, statuses, calls, results, failOn, fail, activity };
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
    temporal.calls.length = 0;
    temporal.results.clear();
    temporal.failOn.clear();
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
    expect(temporal.statuses).toEqual([{ CustomKeywordField: ['running'] }, { CustomKeywordField: ['succeeded'] }]);
  });

  it('updates Temporal status to failed when an activity fails', async () => {
    temporal.fail.value = true;

    await expect(executeWorkflow({ runId: 'workflow-status-failure', definition: singleNodeDefinition() })).rejects.toThrow('activity failed');
    expect(temporal.statuses).toEqual([{ CustomKeywordField: ['running'] }, { CustomKeywordField: ['failed'] }]);
  });

  it('replays conditional branches deterministically', async () => {
    const definition = singleNodeDefinition();
    const trigger = definition.nodes[0]!;
    const yes = { ...trigger, id: 'branch-yes', label: 'Yes branch' };
    const no = { ...trigger, id: 'branch-no', label: 'No branch' };
    definition.nodes = [trigger, yes, no];
    definition.edges = [
      { id: 'to-yes', source: trigger.id, target: yes.id, condition: 'yes' },
      { id: 'to-no', source: trigger.id, target: no.id, condition: 'no' },
    ];
    temporal.results.set(trigger.id, 'yes');

    const result = await executeWorkflow({ runId: 'workflow-status-branch', definition });

    expect(result.completedNodeIds).toEqual([trigger.id, yes.id]);
    expect(temporal.calls).toEqual([trigger.id, yes.id]);
  });

  it('executes declared compensations in reverse completion order after failure', async () => {
    const definition = singleNodeDefinition();
    const trigger = definition.nodes[0]!;
    const prepare = {
      ...trigger,
      id: 'prepare',
      label: 'Prepare',
      unit: {
        ...trigger.unit!,
        compensation: { nodeType: 'code', config: { operation: 'identity', value: 'undo' }, idempotencyKey: 'prepare:compensate:v1' },
      },
    };
    const failNode = { ...trigger, id: 'fail', label: 'Fail' };
    definition.nodes = [trigger, prepare, failNode];
    definition.edges = [
      { id: 'to-prepare', source: trigger.id, target: prepare.id },
      { id: 'to-fail', source: prepare.id, target: failNode.id },
    ];
    temporal.failOn.add(failNode.id);

    await expect(executeWorkflow({ runId: 'workflow-status-compensation', definition })).rejects.toThrow('activity failed');

    expect(temporal.calls).toEqual([trigger.id, prepare.id, failNode.id, 'prepare:compensate']);
    expect(temporal.statuses.at(-1)).toEqual({ CustomKeywordField: ['failed'] });
  });
});
