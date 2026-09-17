import { defaultWorkUnit, knownNodeTypes, triggerNodeTypes } from './catalog.js';
import { workflowDefinitionSchema } from './schema.js';
import type {
  ValidationIssue,
  ValidationResult,
  WorkflowDefinition,
} from './types.js';

function findCycles(workflow: WorkflowDefinition): string[] {
  const adjacency = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();

  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      cycles.add(nodeId);
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }

    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      visit(target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const node of workflow.nodes) {
    visit(node.id);
  }
  return [...cycles];
}

export function validateWorkflow(input: unknown): ValidationResult {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        level: 'error',
        code: 'schema.invalid',
        message: `${issue.path.join('.') || 'workflow'}: ${issue.message}`,
      })),
    };
  }

  const workflow = parsed.data;
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const agent of workflow.agents) {
    if (agentIds.has(agent.id)) {
      issues.push({ level: 'error', code: 'agent.duplicate', message: `Agent ID "${agent.id}" is duplicated.` });
    }
    agentIds.add(agent.id);
  }

  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        level: 'error',
        code: 'node.duplicate',
        message: `Node ID "${node.id}" is duplicated.`,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);

    if (node.unit === undefined) {
      issues.push({
        level: 'error',
        code: 'unit.definition.missing',
        message: 'Every workflow node must declare a versioned work-unit contract.',
        nodeId: node.id,
      });
    } else if (node.unit.kind !== defaultWorkUnit(node.type).kind) {
      issues.push({
        level: 'error',
        code: 'unit.kind.mismatch',
        message: `Node type "${node.type}" must use a ${defaultWorkUnit(node.type).kind} work unit.`,
        nodeId: node.id,
      });
    }
    const compensation = node.unit?.compensation;
    if (compensation !== undefined) {
      if (!knownNodeTypes.has(compensation.nodeType)) {
        issues.push({ level: 'error', code: 'unit.compensation.unknown', message: `Compensation node type "${compensation.nodeType}" is not registered.`, nodeId: node.id });
      }
    }

    if (!knownNodeTypes.has(node.type)) {
      issues.push({
        level: 'error',
        code: 'node.unknown',
        message: `Node type "${node.type}" is not registered.`,
        nodeId: node.id,
      });
    }

    if (node.type === 'agentLoop') {
      const agentId = node.config.agentId;
      const agent = typeof agentId === 'string'
        ? workflow.agents.find((candidate) => candidate.id === agentId)
        : undefined;
      if (agent === undefined) {
        issues.push({
          level: 'error',
          code: 'agent.definition.missing',
          message: 'Agent loops must reference an agent definition declared by the workflow creator.',
          nodeId: node.id,
        });
      }
      const maxIterations = node.config.maxIterations;
      if (
        typeof maxIterations !== 'number' ||
        !Number.isInteger(maxIterations) ||
        maxIterations < 1 ||
        maxIterations > 25
      ) {
        issues.push({
          level: 'error',
          code: 'agent.budget',
          message: 'Agent loops require maxIterations between 1 and 25.',
          nodeId: node.id,
        });
      }
      if (agent !== undefined && typeof maxIterations === 'number' && maxIterations > agent.limits.maxIterations) {
        issues.push({
          level: 'error',
          code: 'agent.limit.exceeded',
          message: `Agent loop iterations cannot exceed the referenced agent limit of ${agent.limits.maxIterations}.`,
          nodeId: node.id,
        });
      }
    }
  }

  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        level: 'error',
        code: 'edge.duplicate',
        message: `Edge ID "${edge.id}" is duplicated.`,
      });
    }
    edgeIds.add(edge.id);

    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({
        level: 'error',
        code: 'edge.orphan',
        message: `Edge "${edge.id}" references a missing node.`,
      });
    }
    if (edge.source === edge.target) {
      issues.push({
        level: 'error',
        code: 'edge.self',
        message: `Node "${edge.source}" cannot connect to itself.`,
        nodeId: edge.source,
      });
    }
  }

  const triggers = workflow.nodes.filter((node) => triggerNodeTypes.has(node.type));
  if (triggers.length !== 1) {
    issues.push({
      level: 'error',
      code: 'trigger.count',
      message: `A workflow must contain exactly one trigger; found ${triggers.length}.`,
    });
  } else if (triggers[0]?.type !== workflow.trigger.type) {
    issues.push({
      level: 'error',
      code: 'trigger.mismatch',
      message: 'The workflow trigger metadata does not match its trigger node.',
      nodeId: triggers[0]?.id,
    });
  }

  for (const nodeId of findCycles(workflow)) {
    issues.push({
      level: 'error',
      code: 'graph.cycle',
      message: 'Graph cycles must be represented by a bounded agent-loop node.',
      nodeId,
    });
  }

  const trigger = triggers[0];
  if (trigger !== undefined) {
    const reachable = new Set<string>([trigger.id]);
    const pending = [trigger.id];
    while (pending.length > 0) {
      const source = pending.shift();
      for (const edge of workflow.edges.filter(
        (candidate) => candidate.source === source,
      )) {
        if (!reachable.has(edge.target)) {
          reachable.add(edge.target);
          pending.push(edge.target);
        }
      }
    }
    for (const node of workflow.nodes.filter(
      (candidate) => !reachable.has(candidate.id),
    )) {
      issues.push({
        level: 'warning',
        code: 'node.disconnected',
        message: 'This node is unreachable from the trigger and will not execute.',
        nodeId: node.id,
      });
    }
  }

  return {
    valid: !issues.some((issue) => issue.level === 'error'),
    issues,
  };
}
