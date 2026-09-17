import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';

import { defaultWorkUnit, knownNodeTypes } from '../domain/catalog.js';
import { agentDefinitionSchema } from '../domain/schema.js';
import type { AgentDefinition, ProjectRecord, SourceDiagnostic, WorkflowDefinition, WorkflowNode } from '../domain/types.js';
import { validateWorkflow } from '../domain/validator.js';

export interface DeclarativeProjectDocument {
  apiVersion: 'factory.agentic/v1';
  kind: 'Project';
  metadata: { name: string; id?: string; description?: string };
  agents: Array<Partial<AgentDefinition> & { id: string }>;
  workflows: Array<{
    id?: string;
    name: string;
    description?: string;
    version?: number;
    trigger?: string;
    inputSchema?: Record<string, unknown>;
    steps: Array<Record<string, unknown>>;
    edges?: Array<{
      id?: string;
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
      condition?: string;
    }>;
  }>;
}

export class DeclarativeSourceError extends Error {
  public readonly diagnostics: SourceDiagnostic[];

  public constructor(message: string, diagnostics: SourceDiagnostic[]) {
    super(message);
    this.name = 'DeclarativeSourceError';
    this.diagnostics = diagnostics;
  }
}

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

const declarativeDocumentSchema = z.object({
  apiVersion: z.literal('factory.agentic/v1'),
  kind: z.literal('Project'),
  metadata: z.object({
    name: z.string().min(1),
    id: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
  agents: z.array(z.object({ id: z.string().min(1) }).passthrough()).default([]),
  workflows: z.array(z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.number().int().positive().optional(),
    trigger: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())),
    edges: z.array(z.object({
      id: z.string().min(1).optional(),
      source: z.string().min(1),
      target: z.string().min(1),
      sourceHandle: z.string().min(1).optional(),
      targetHandle: z.string().min(1).optional(),
      condition: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).default([]),
});

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function triggerType(value: unknown): string {
  if (value === 'schedule') return 'scheduleTrigger';
  if (value === 'webhook') return 'webhookTrigger';
  if (value === 'manual' || value === undefined) return 'manualTrigger';
  return String(value);
}

function defaultAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    version: 1,
    name,
    purpose: 'Complete the declared workflow task within policy.',
    instructions: 'Follow the workflow input and stop when the success criteria are met.',
    skills: [],
    tools: [],
    model: { routingAlias: 'default-safe' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    boundaries: {
      allowedConnections: [],
      allowedRepositories: [],
      protectedPaths: [],
      network: 'deny-by-default',
      dataClasses: ['internal'],
    },
    limits: { maxIterations: 3, maxCostUsd: 0.05, maxDurationMs: 60_000 },
    termination: { successConditions: ['Task is complete.'], failureConditions: [], escalationConditions: [] },
    approval: { beforeSideEffects: false, beforeTools: [] },
    observability: { captureInputs: false, captureOutputs: false, redactedFields: ['prompt', 'output', 'secret'] },
  };
}

function buildAgent(input: Partial<AgentDefinition> & { id: string }): AgentDefinition {
  const base = defaultAgent(input.id, input.name ?? input.id);
  const merged = {
    ...base,
    ...input,
    model: { ...base.model, ...(input.model ?? {}) },
    boundaries: { ...base.boundaries, ...(input.boundaries ?? {}) },
    limits: { ...base.limits, ...(input.limits ?? {}) },
    termination: { ...base.termination, ...(input.termination ?? {}) },
    approval: { ...base.approval, ...(input.approval ?? {}) },
    observability: { ...base.observability, ...(input.observability ?? {}) },
  };
  const result = agentDefinitionSchema.safeParse(merged);
  if (!result.success) throw new Error(`Invalid agent "${input.id}": ${result.error.issues.map((issue) => issue.message).join(', ')}`);
  return result.data;
}

function stepNode(step: Record<string, unknown>, index: number, agents: AgentDefinition[]): WorkflowNode {
  const id = typeof step.id === 'string' ? step.id : `${String(step.kind ?? step.type ?? 'step')}-${index + 1}`;
  const kind = typeof step.kind === 'string' ? step.kind : undefined;
  const requestedType = typeof step.type === 'string' ? step.type : undefined;
  const type = requestedType ?? (kind === 'agent' ? 'agentLoop' : kind === 'human' ? 'approval' : kind === 'connector' ? 'httpRequest' : kind === 'consumer' ? 'notification' : 'code');
  if (!knownNodeTypes.has(type)) throw new Error(`Unknown YAML step type "${type}".`);
  const config = typeof step.config === 'object' && step.config !== null ? { ...(step.config as Record<string, unknown>) } : {};
  if (type === 'code' && typeof step.operation === 'string') config.operation = step.operation;
  if (type === 'agentLoop') {
    const agentId = typeof step.agent === 'string' ? step.agent : agents[0]?.id;
    if (agentId !== undefined) config.agentId = agentId;
    if (typeof step.goal === 'string') config.goal = step.goal;
    if (typeof step.maxIterations === 'number') config.maxIterations = step.maxIterations;
    else if (agentId !== undefined) {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent !== undefined) config.maxIterations = agent.limits.maxIterations;
    }
  }
  if (type === 'approval' && typeof step.instructions === 'string') config.instructions = step.instructions;
  return {
    id,
    type,
    label: typeof step.name === 'string' ? step.name : id,
    position: { x: 80 + index * 260, y: 180 },
    config,
    unit: typeof step.unit === 'object' && step.unit !== null
      ? step.unit as WorkflowNode['unit']
      : defaultWorkUnit(type),
  };
}

export function parseProjectYaml(source: string, scope: { tenantId: string; projectId?: string }): {
  project: ProjectRecord;
  workflows: WorkflowDefinition[];
} {
  const yamlDocument = parseDocument(source);
  if (yamlDocument.errors.length > 0) {
    const yamlError = yamlDocument.errors[0];
    const rawMessage = yamlError?.message ?? 'Invalid YAML syntax.';
    // YAML parser messages may append source excerpts; keep diagnostics safe for API/UI responses.
    const message = rawMessage.split(/\r?\n/, 1)[0] ?? 'Invalid YAML syntax.';
    const position = yamlError?.pos?.[0] ?? 0;
    const { line, column } = lineColumnAt(source, position);
    throw new DeclarativeSourceError(`Invalid project YAML: ${message}`, [{ severity: 'error', path: 'project.yaml', line, column, code: 'yaml.parse', message }]);
  }
  const parsed: unknown = yamlDocument.toJS();
  const result = declarativeDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const diagnostics = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || 'document';
      const node = yamlDocument.getIn(issue.path, true) as { range?: [number, number, number] } | undefined;
      const { line, column } = lineColumnAt(source, node?.range?.[0] ?? 0);
      return { severity: 'error' as const, path: 'project.yaml', line, column, code: 'yaml.schema', message: `${path}: ${issue.message}` };
    });
    throw new DeclarativeSourceError(`Invalid project YAML: ${diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`, diagnostics);
  }
  const document = result.data as DeclarativeProjectDocument;
  const now = new Date().toISOString();
  const projectId = scope.projectId ?? document.metadata.id ?? `project-${slug(document.metadata.name)}`;
  const agents = (document.agents ?? []).map((agent) => buildAgent(agent));
  const project: ProjectRecord = {
    id: projectId,
    tenantId: scope.tenantId,
    name: document.metadata.name,
    description: document.metadata.description ?? '',
    createdAt: now,
  };
  const workflows = (document.workflows ?? []).map((definition, workflowIndex) => {
    const trigger = triggerType(definition.trigger);
    const triggerNode: WorkflowNode = {
      id: 'trigger',
      type: trigger,
      label: trigger === 'manualTrigger' ? 'Manual trigger' : trigger,
      position: { x: 40, y: 180 },
      config: {},
      unit: defaultWorkUnit(trigger),
    };
    const nodes = [triggerNode, ...definition.steps.map((step, index) => stepNode(step, index + 1, agents))];
    const sequentialEdges = nodes.slice(0, -1).map((node, index) => ({ id: `edge-${node.id}-${nodes[index + 1]?.id ?? 'end'}`, source: node.id, target: nodes[index + 1]?.id ?? node.id }));
    const edges = definition.edges === undefined
      ? sequentialEdges
      : definition.edges.map((edge, edgeIndex) => ({
        id: edge.id ?? `edge-${edge.source}-${edge.target}-${edgeIndex + 1}`,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
        ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
        ...(edge.condition === undefined ? {} : { condition: edge.condition }),
      }));
    const workflow: WorkflowDefinition = {
      tenantId: scope.tenantId,
      projectId,
      id: definition.id ?? `workflow-${slug(definition.name)}-${workflowIndex + 1}`,
      name: definition.name,
      description: definition.description ?? '',
      version: definition.version ?? 1,
      status: 'draft',
      trigger: { type: trigger },
      ...(definition.inputSchema === undefined ? {} : { inputSchema: definition.inputSchema }),
      agents: structuredClone(agents),
      nodes,
      edges,
      createdAt: now,
      updatedAt: now,
    };
    const validation = validateWorkflow(workflow);
    if (!validation.valid) throw new Error(`Workflow "${workflow.name}" is invalid: ${validation.issues.map((issue) => issue.message).join(' ')}`);
    return workflow;
  });
  return { project, workflows };
}

export function stringifyProjectYaml(project: ProjectRecord, workflows: WorkflowDefinition[]): string {
  const agents = [...new Map(workflows.flatMap((workflow) => workflow.agents).map((agent) => [agent.id, agent])).values()];
  return stringify({
    apiVersion: 'factory.agentic/v1',
    kind: 'Project',
    metadata: { id: project.id, name: project.name, description: project.description },
    agents,
    workflows: workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      version: workflow.version,
      trigger: workflow.trigger.type.replace('Trigger', '').toLowerCase(),
      ...(workflow.inputSchema === undefined ? {} : { inputSchema: workflow.inputSchema }),
      steps: workflow.nodes.filter((node) => node.type !== workflow.trigger.type).map((node) => ({
        id: node.id,
        name: node.label,
        type: node.type,
        config: node.config,
        unit: node.unit,
      })),
      edges: workflow.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
        ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
        ...(edge.condition === undefined ? {} : { condition: edge.condition }),
      })),
    })),
  });
}
