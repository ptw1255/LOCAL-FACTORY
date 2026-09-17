import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import type { WorkflowDefinition } from '../domain/types.js';
import type * as activities from './activities.js';
import type { TemporalActivityLifecycle } from './observability.js';

const { executeNodeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
  },
});

export const approveSignal = defineSignal<[string]>('approve');
export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');

export interface TemporalWorkflowInput {
  runId: string;
  definition: WorkflowDefinition;
  releaseBundleHash?: string;
  pinnedAgentVersions?: Record<string, number>;
  input?: unknown;
}

export interface TemporalWorkflowResult {
  completedNodeIds: string[];
  unitOutputs: Record<string, unknown>;
  lifecycle: TemporalActivityLifecycle[];
}

export async function executeWorkflow(
  input: TemporalWorkflowInput,
): Promise<TemporalWorkflowResult> {
  const completed = new Set<string>();
  const outputs = new Map<string, unknown>();
  const lifecycleByNode = new Map<string, TemporalActivityLifecycle>();
  const lifecycle: TemporalActivityLifecycle[] = [];
  const trigger = input.definition.nodes.find(
    (node) => node.type === input.definition.trigger.type,
  );
  if (trigger === undefined) {
    throw new Error('The declared workflow trigger node is missing.');
  }
  const activated = new Set([trigger.id]);
  const approved = new Set<string>();
  let paused = false;
  setHandler(approveSignal, (nodeId) => {
    approved.add(nodeId);
  });
  setHandler(pauseSignal, () => {
    paused = true;
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });

  while (completed.size < activated.size) {
    await condition(() => !paused);
    const node = input.definition.nodes.find((candidate) => {
      if (!activated.has(candidate.id) || completed.has(candidate.id)) {
        return false;
      }
      return input.definition.edges
        .filter(
          (edge) => edge.target === candidate.id && activated.has(edge.source),
        )
        .every((edge) => completed.has(edge.source));
    });

    if (node === undefined) {
      throw new Error('No executable node is available for the active graph.');
    }
    if (node.type === 'approval') {
      await condition(() => approved.has(node.id) || paused);
      await condition(() => !paused);
      if (!approved.has(node.id)) continue;
    }

    const activityConfig = { ...node.config };
    if (node.type === 'agentLoop') {
      const agentId = node.config.agentId;
      const agent = typeof agentId === 'string'
        ? input.definition.agents.find((candidate) => candidate.id === agentId)
        : undefined;
      if (agent === undefined) {
        throw new Error('Agent loop references a missing agent definition.');
      }
      activityConfig.maxIterations = Math.min(
        typeof node.config.maxIterations === 'number' ? node.config.maxIterations : agent.limits.maxIterations,
        agent.limits.maxIterations,
      );
    }

    const parentSpanId = input.definition.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => lifecycleByNode.get(edge.source)?.spanId)
      .find((spanId): spanId is string => spanId !== undefined);
    const activityResult = await executeNodeActivity({
      runId: input.runId,
      workflowId: input.definition.id,
      workflowVersion: input.definition.version,
      ...(input.releaseBundleHash === undefined ? {} : { releaseBundleHash: input.releaseBundleHash }),
      ...(input.pinnedAgentVersions === undefined ? {} : { pinnedAgentVersions: input.pinnedAgentVersions }),
      ...(input.definition.tenantId === undefined ? {} : { tenantId: input.definition.tenantId }),
      ...(input.definition.projectId === undefined ? {} : { projectId: input.definition.projectId }),
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      config: activityConfig,
      traceId: input.runId,
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      sequence: completed.size + 1,
      inputs: input.definition.edges
        .filter((edge) => edge.target === node.id && outputs.has(edge.source))
        .map((edge) => outputs.get(edge.source))
        .concat(completed.size === 0 && node.type === input.definition.trigger.type && input.input !== undefined ? [input.input] : []),
      unit: node.unit,
    });
    completed.add(node.id);
    outputs.set(node.id, activityResult.result);
    lifecycleByNode.set(node.id, activityResult.lifecycle);
    lifecycle.push(activityResult.lifecycle);
    for (const edge of input.definition.edges.filter(
      (candidate) =>
        candidate.source === node.id &&
        (candidate.condition === undefined ||
          candidate.condition.toLowerCase() ===
            String(activityResult.result).toLowerCase()),
    )) {
      activated.add(edge.target);
    }
  }

  return { completedNodeIds: [...completed], unitOutputs: Object.fromEntries(outputs), lifecycle };
}
