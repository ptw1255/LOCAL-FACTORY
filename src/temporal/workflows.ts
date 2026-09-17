import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import { defaultWorkUnit } from '../domain/catalog.js';
import type { WorkflowDefinition } from '../domain/types.js';
import type * as activities from './activities.js';
import type { TemporalActivityLifecycle } from './observability.js';

const { executeNodeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
  },
});
// Tool-capable agent nodes are fail-closed on uncertain completion: retries
// would replay provider-requested side effects without a durable tool result.
const { executeAgentNodeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
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

export interface TemporalCompensationPlan {
  sourceNodeId: string;
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
  idempotencyKey: string;
}

/** Build the deterministic reverse-order compensation plan for a failed run. */
export function planCompensations(definition: WorkflowDefinition, completedNodeIds: string[]): TemporalCompensationPlan[] {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  return [...completedNodeIds].reverse().flatMap((sourceNodeId) => {
    const compensation = nodes.get(sourceNodeId)?.unit?.compensation;
    return compensation === undefined ? [] : [{ sourceNodeId, nodeId: `${sourceNodeId}:compensate`, nodeType: compensation.nodeType, config: compensation.config, idempotencyKey: compensation.idempotencyKey }];
  });
}

/** Approval boundary shared by explicit human gates and side-effect WorkUnits. */
export function requiresTemporalApproval(node: WorkflowDefinition['nodes'][number]): boolean {
  return node.type === 'approval' || node.config.requiresApproval === true;
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
    if (requiresTemporalApproval(node)) {
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
      // The definition is immutable run input and contains only Vault references,
      // never resolved credentials. Pass it to the activity so provider routing
      // remains identical to the local execution plane.
      activityConfig.agent = agent;
    }

    const parentSpanId = input.definition.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => lifecycleByNode.get(edge.source)?.spanId)
      .find((spanId): spanId is string => spanId !== undefined);
    let activityResult: Awaited<ReturnType<typeof executeNodeActivity>>;
    try {
      const execute = node.type === 'agentLoop' ? executeAgentNodeActivity : executeNodeActivity;
      activityResult = await execute({
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
    } catch (error) {
      await executeCompensations(input, [...completed].map((id) => input.definition.nodes.find((candidate) => candidate.id === id)).filter((candidate): candidate is WorkflowDefinition['nodes'][number] => candidate !== undefined), outputs, approved);
      throw error;
    }
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

/** Execute declared compensations in reverse completion order. Temporal history
 * makes each activity invocation durable and replay-safe; a failed compensation
 * is surfaced with the original failure rather than being silently ignored. */
async function executeCompensations(
  input: TemporalWorkflowInput,
  completedNodes: WorkflowDefinition['nodes'],
  outputs: Map<string, unknown>,
  approved: Set<string>,
): Promise<void> {
  const failures: string[] = [];
  let sequence = input.definition.nodes.length + completedNodes.length;
  const nodesById = new Map(completedNodes.map((node) => [node.id, node]));
  for (const plan of planCompensations(input.definition, completedNodes.map((node) => node.id))) {
    const node = nodesById.get(plan.sourceNodeId);
    if (node === undefined) continue;
    sequence += 1;
    try {
      if (plan.config.requiresApproval === true) {
        await condition(() => approved.has(plan.nodeId));
      }
      await executeNodeActivity({
        runId: input.runId,
        workflowId: input.definition.id,
        workflowVersion: input.definition.version,
        ...(input.releaseBundleHash === undefined ? {} : { releaseBundleHash: input.releaseBundleHash }),
        ...(input.pinnedAgentVersions === undefined ? {} : { pinnedAgentVersions: input.pinnedAgentVersions }),
        ...(input.definition.tenantId === undefined ? {} : { tenantId: input.definition.tenantId }),
        ...(input.definition.projectId === undefined ? {} : { projectId: input.definition.projectId }),
        nodeId: plan.nodeId,
        nodeType: plan.nodeType,
        label: `Compensate ${node.label}`,
        config: plan.config,
        traceId: input.runId,
        sequence,
        inputs: outputs.has(node.id) ? [outputs.get(node.id)] : [],
        unit: { ...defaultWorkUnit(plan.nodeType), idempotencyKey: plan.idempotencyKey },
      });
    } catch (error) {
      failures.push(`${plan.nodeId}: ${error instanceof Error ? error.message : 'unknown failure'}`);
    }
  }
  if (failures.length > 0) throw new Error(`Workflow compensation failed: ${failures.join('; ')}`);
}
