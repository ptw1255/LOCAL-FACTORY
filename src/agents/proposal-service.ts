import { randomUUID } from 'node:crypto';

import { defaultWorkUnit, nodeCatalog } from '../domain/catalog.js';
import type {
  AgentDefinition,
  AgentProposal,
  AuthoringBrief,
  WorkflowDefinition,
  WorkflowNode,
} from '../domain/types.js';
import { validateWorkflow } from '../domain/validator.js';
import type { PlatformStore } from '../storage/store.js';

interface PlannedNode {
  type: string;
  reason: string;
  label?: string;
  config?: Record<string, unknown>;
}

const keywordPlans: Array<{
  pattern: RegExp;
  node: PlannedNode;
}> = [
  {
    pattern: /\b(webhook|event|incoming|receive)\b/i,
    node: { type: 'webhookTrigger', reason: 'The goal describes event-driven intake.' },
  },
  {
    pattern: /\b(schedule|daily|weekly|cron)\b/i,
    node: { type: 'scheduleTrigger', reason: 'The goal describes scheduled work.' },
  },
  {
    pattern: /\b(fetch|http|api|endpoint)\b/i,
    node: { type: 'httpRequest', reason: 'The goal requires an external API call.' },
  },
  {
    pattern: /\b(approve|approval|review|human)\b/i,
    node: { type: 'approval', reason: 'The goal requests a human decision boundary.' },
  },
  {
    pattern: /\b(agent|reason|investigate|analy[sz]e|plan)\b/i,
    node: { type: 'agentLoop', reason: 'The goal benefits from bounded agent reasoning.' },
  },
  {
    pattern: /\b(notify|message|alert|email)\b/i,
    node: { type: 'notification', reason: 'The goal includes an operator notification.' },
  },
];

function makeNode(planned: PlannedNode, index: number): WorkflowNode {
  const catalogItem = nodeCatalog.find((item) => item.type === planned.type);
  if (catalogItem === undefined) {
    throw new Error(`Cannot plan unknown node type "${planned.type}".`);
  }
  return {
    // Node identities become resource paths, so they must remain stable when
    // the same intent produces the same plan. The proposal record itself is
    // still uniquely identified below.
    id: `${planned.type}-${index + 1}`,
    type: planned.type,
    label: planned.label ?? catalogItem.label,
    position: { x: 60 + index * 260, y: 180 },
    config: { ...structuredClone(catalogItem.defaultConfig), ...(planned.config ?? {}) },
    unit: defaultWorkUnit(planned.type),
  };
}

function stageLabel(value: string, fallback: string): string {
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact === '' ? fallback : compact.length <= 64 ? compact : `${compact.slice(0, 63)}…`;
}

function selectPlan(goal: string): PlannedNode[] {
  const selected = keywordPlans
    .filter((candidate) => candidate.pattern.test(goal))
    .map((candidate) => candidate.node);

  const trigger = selected.find((candidate) =>
    ['webhookTrigger', 'scheduleTrigger'].includes(candidate.type),
  ) ?? {
    type: 'manualTrigger',
    reason: 'A manual trigger keeps the first proposal safe and reviewable.',
  };
  const operations = selected.filter(
    (candidate) =>
      !['webhookTrigger', 'scheduleTrigger', 'manualTrigger'].includes(
        candidate.type,
      ),
  );

  if (!operations.some((candidate) => candidate.type === 'agentLoop')) {
    operations.unshift({
      type: 'transform',
      reason: 'Normalize inputs before side effects or final output.',
    });
  }
  return [
    trigger,
    ...operations,
    {
      type: 'output',
      reason: 'Every proposal declares an observable terminal result.',
    },
  ];
}

function selectBriefPlan(brief: AuthoringBrief): PlannedNode[] {
  const trigger: PlannedNode = brief.trigger === 'webhook'
    ? { type: 'webhookTrigger', reason: 'The draft explicitly selects webhook intake.', label: 'Receive webhook' }
    : brief.trigger === 'schedule'
      ? { type: 'scheduleTrigger', reason: 'The draft explicitly selects scheduled intake.', label: 'Run on schedule' }
      : { type: 'manualTrigger', reason: 'The draft explicitly selects manual intake.', label: 'Start manually' };
  const preparation: PlannedNode = {
    type: 'transform',
    reason: 'The draft declares deterministic preparation before agent work.',
    label: stageLabel(brief.preparation, 'Prepare input'),
    config: { value: brief.preparation },
  };
  const agent = brief.agentTask.trim() === '' ? undefined : {
    type: 'agentLoop',
    reason: 'The draft assigns a bounded responsibility to an agent.',
    label: stageLabel(brief.agentTask, 'Perform agent task'),
    config: { goal: brief.agentTask, ...(brief.constraints.trim() === '' ? {} : { constraints: brief.constraints }) },
  } satisfies PlannedNode;
  const actionText = brief.externalAction.trim();
  const actionUrl = actionText.match(/https?:\/\/\S+/i)?.[0];
  const action = actionText === '' || /^(none|n\/a)$/i.test(actionText) ? undefined : {
    type: actionUrl === undefined ? 'notification' : 'httpRequest',
    reason: 'The draft declares an external action or side effect.',
    label: stageLabel(actionText, 'Perform external action'),
    config: actionUrl === undefined ? { message: actionText } : { method: 'POST', url: actionUrl },
  } satisfies PlannedNode;
  const approval = brief.approval === 'none' ? undefined : {
    type: 'approval',
    reason: `The draft requires approval ${brief.approval.replaceAll('-', ' ')}.`,
    label: brief.approval === 'before-side-effects' ? 'Approve side effect' : 'Approve completion',
    config: { instructions: `Review ${brief.objective} ${brief.approval.replaceAll('-', ' ')}.` },
  } satisfies PlannedNode;
  const output: PlannedNode = {
    type: 'output',
    reason: 'The draft declares an observable terminal result.',
    label: stageLabel(brief.output, 'Return result'),
    config: { value: brief.output },
  };
  const stages: PlannedNode[] = [trigger, preparation];
  if (agent !== undefined) stages.push(agent);
  if (approval !== undefined && brief.approval === 'before-side-effects') stages.push(approval);
  if (action !== undefined) stages.push(action);
  if (approval !== undefined && brief.approval === 'before-completion') stages.push(approval);
  stages.push(output);
  return stages;
}

function draftAgent(workflow: WorkflowDefinition, goal: string, brief?: AuthoringBrief): AgentDefinition {
  const task = brief?.agentTask.trim() || goal;
  const constraints = brief?.constraints.trim();
  return {
    id: `${workflow.id}-agent`,
    version: 1,
    name: `${workflow.name} agent`,
    purpose: task,
    instructions: constraints === undefined || constraints === '' ? task : `${task}\nConstraints: ${constraints}`,
    skills: ['workflow-reasoning'],
    tools: [],
    model: { routingAlias: 'default-safe' },
    inputSchema: { type: 'object', ...(brief === undefined ? {} : { description: brief.input }) },
    outputSchema: { type: 'object', ...(brief === undefined ? {} : { description: brief.output }) },
    boundaries: { allowedConnections: [], allowedRepositories: [], protectedPaths: [], network: 'deny-by-default', dataClasses: ['internal'] },
    limits: { maxIterations: 3, maxCostUsd: 0.01, maxDurationMs: 60_000 },
    termination: {
      successConditions: ['The declared agent responsibility is complete.'],
      failureConditions: ['Required workflow context is unavailable.'],
      escalationConditions: ['The task cannot be completed within declared boundaries.'],
    },
    approval: { beforeSideEffects: brief?.approval === 'before-side-effects', beforeTools: [] },
    observability: { captureInputs: false, captureOutputs: false, redactedFields: ['prompt', 'output', 'secret'] },
  };
}

export class ProposalService {
  public constructor(private readonly store: PlatformStore) {}

  public async create(
    workflow: WorkflowDefinition,
    goal: string,
  ): Promise<AgentProposal> {
    const proposal = this.plan(workflow, goal);
    await this.store.mutate((state) => {
      state.proposals.unshift(proposal);
    });
    return proposal;
  }

  /** Produce an AI authoring plan without persisting the legacy aggregate
   * proposal. Project authoring wraps this plan in a reviewable file diff. */
  public plan(workflow: WorkflowDefinition, goal: string, brief?: AuthoringBrief): AgentProposal {
    const selected = brief === undefined ? selectPlan(goal) : selectBriefPlan(brief);
    const now = new Date().toISOString();
    const nodes = selected.map((item, index) => makeNode(item, index));
    const needsAgent = nodes.some((candidate) => candidate.type === 'agentLoop');
    const agents = workflow.agents.length > 0 || !needsAgent ? structuredClone(workflow.agents) : [draftAgent(workflow, goal, brief)];
    const agentDefinition = agents[0];
    for (const node of nodes.filter((candidate) => candidate.type === 'agentLoop')) {
      if (agentDefinition !== undefined) {
        node.config.agentId = agentDefinition.id;
        node.config.maxIterations = Math.min(
          Number(node.config.maxIterations ?? 1),
          agentDefinition.limits.maxIterations,
        );
      }
    }
    const proposed: WorkflowDefinition = {
      ...structuredClone(workflow),
      id: workflow.id,
      name: workflow.name,
      description: goal,
      version: workflow.version + 1,
      status: 'draft',
      agents,
      ...(brief === undefined ? {} : { inputSchema: { type: 'object', description: brief.input } }),
      trigger: { type: nodes[0]?.type ?? 'manualTrigger' },
      nodes,
      edges: nodes.slice(0, -1).map((node, index) => ({
        id: `edge-${node.id}-${nodes[index + 1]?.id ?? 'output'}`,
        source: node.id,
        target: nodes[index + 1]?.id ?? node.id,
      })),
      updatedAt: now,
    };
    const validation = validateWorkflow(proposed);
    const proposal: AgentProposal = {
      ...(workflow.tenantId === undefined ? {} : { tenantId: workflow.tenantId }),
      ...(workflow.projectId === undefined ? {} : { projectId: workflow.projectId }),
      id: randomUUID(),
      workflowId: workflow.id,
      goal,
      summary: `Proposed ${nodes.length} nodes for: ${goal}`,
      rationale: selected.map((item) => item.reason),
      workflow: proposed,
      issues: validation.issues,
      createdAt: now,
    };
    return proposal;
  }
}
