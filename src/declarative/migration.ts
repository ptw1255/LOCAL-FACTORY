import { isMap, isSeq, parse, parseDocument, stringify, type YAMLMap, type YAMLSeq } from 'yaml';

import type { ProjectRecord, WorkUnitDefinition, WorkflowDefinition } from '../domain/types.js';

export interface MigrationResourceFile {
  path: string;
  source: string;
}

export interface ResourceMigrationPlan {
  files: MigrationResourceFile[];
  sourceProjectId: string;
  sourceWorkflowIds: string[];
  sourceAgentIds: string[];
}

function envelope(kind: string, id: string, version: number, name: string | undefined, spec: Record<string, unknown>): Record<string, unknown> {
  return {
    apiVersion: 'factory.agentic/v1',
    kind,
    metadata: { id, version, ...(name === undefined ? {} : { name }) },
    spec,
  };
}

function file(path: string, document: Record<string, unknown>): MigrationResourceFile {
  return { path, source: stringify(document) };
}

/**
 * Use the same deterministic convention as the migration planner for the
 * WorkUnit module attached to a workflow node. Keeping this in one place lets
 * Canvas edits update the referenced module instead of embedding runtime
 * state back into the aggregate Workflow record.
 */
export function workUnitResourceId(workflowId: string, nodeId: string): string {
  return `unit-${workflowId}-${nodeId}`;
}

/** Render a new standalone WorkUnit module. */
export function renderWorkUnitResource(unitId: string, unit: WorkUnitDefinition): string {
  return stringify(envelope('WorkUnit', unitId, unit.version, undefined, unit as unknown as Record<string, unknown>));
}

function parsedMap(document: ReturnType<typeof parseDocument>, path: string[]): YAMLMap {
  const node = document.getIn(path, true);
  if (!isMap(node)) throw new Error(`Expected a YAML mapping at ${path.join('.')}.`);
  return node;
}

function parsedSequence(document: ReturnType<typeof parseDocument>, path: string[]): YAMLSeq {
  const node = document.getIn(path, true);
  if (!isSeq(node)) throw new Error(`Expected a YAML sequence at ${path.join('.')}.`);
  return node;
}

function setOptionalMapValue(map: YAMLMap, key: string, value: unknown): void {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}

/**
 * Patch a WorkUnit module in place. YAML's document model retains comments
 * and unrelated keys while changing only the authored envelope fields.
 */
export function patchWorkUnitResource(source: string, unit: WorkUnitDefinition): string {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? 'Invalid WorkUnit YAML.');
  if (document.get('kind') !== 'WorkUnit') throw new Error('Expected a WorkUnit resource.');
  const metadata = parsedMap(document, ['metadata']);
  const spec = parsedMap(document, ['spec']);
  metadata.set('version', unit.version);
  const fields: Array<keyof WorkUnitDefinition> = ['kind', 'version', 'inputSchema', 'outputSchema', 'timeoutMs', 'retryAttempts', 'idempotencyKey', 'compensation'];
  for (const key of fields) setOptionalMapValue(spec, key, unit[key]);
  for (const key of ['id', 'name', 'createdAt', 'updatedAt']) spec.delete(key);
  return document.toString();
}

function workflowStepResource(workflow: WorkflowDefinition, node: WorkflowDefinition['nodes'][number]): Record<string, unknown> {
  return {
    id: node.id,
    name: node.label,
    type: node.type,
    config: node.config,
    ...(node.unit === undefined ? {} : { unit: `WorkUnit/${workUnitResourceId(workflow.id, node.id)}` }),
  };
}

function workflowEdgeResources(workflow: WorkflowDefinition): Array<Record<string, unknown>> {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
    ...(edge.condition === undefined ? {} : { condition: edge.condition }),
  }));
}

/**
 * Patch a workflow resource from a Canvas projection without replacing the
 * YAML document. Existing step mappings are reused so comments attached to
 * unchanged steps survive add/remove/configuration operations.
 */
export function patchWorkflowResource(source: string, workflow: WorkflowDefinition): string {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? 'Invalid Workflow YAML.');
  if (document.get('kind') !== 'Workflow') throw new Error('Expected a Workflow resource.');
  const metadata = parsedMap(document, ['metadata']);
  const spec = parsedMap(document, ['spec']);
  metadata.set('version', workflow.version);
  setOptionalMapValue(metadata, 'name', workflow.name);
  setOptionalMapValue(spec, 'description', workflow.description);
  spec.set('trigger', workflow.trigger.type.replace(/Trigger$/, '').toLowerCase());
  setOptionalMapValue(spec, 'inputSchema', workflow.inputSchema);
  spec.set('edges', workflowEdgeResources(workflow));

  const steps = parsedSequence(document, ['spec', 'steps']);
  const existingById = new Map<string, YAMLMap>();
  for (const item of steps.items) {
    if (!isMap(item)) continue;
    const id = item.get('id');
    if (typeof id === 'string') existingById.set(id, item);
  }
  const semanticNodes = workflow.nodes.filter((node) => node.type !== workflow.trigger.type);
  steps.items = semanticNodes.map((node) => {
    const existing = existingById.get(node.id);
    if (existing === undefined) return document.createNode(workflowStepResource(workflow, node));
    existing.set('id', node.id);
    existing.set('name', node.label);
    existing.set('type', node.type);
    existing.set('config', node.config);
    setOptionalMapValue(existing, 'unit', node.unit === undefined ? undefined : `WorkUnit/${workUnitResourceId(workflow.id, node.id)}`);
    const agentId = node.type === 'agentLoop' && typeof node.config.agentId === 'string' ? node.config.agentId : undefined;
    const goal = node.type === 'agentLoop' && typeof node.config.goal === 'string' ? node.config.goal : undefined;
    const maxIterations = node.type === 'agentLoop' && typeof node.config.maxIterations === 'number' ? node.config.maxIterations : undefined;
    const operation = node.type === 'code' && typeof node.config.operation === 'string' ? node.config.operation : undefined;
    const instructions = node.type === 'approval' && typeof node.config.instructions === 'string' ? node.config.instructions : undefined;
    setOptionalMapValue(existing, 'agent', agentId);
    setOptionalMapValue(existing, 'goal', goal);
    setOptionalMapValue(existing, 'maxIterations', maxIterations);
    setOptionalMapValue(existing, 'operation', operation);
    setOptionalMapValue(existing, 'instructions', instructions);
    return existing;
  });
  return document.toString();
}

export function renderCanvasResource(workflow: WorkflowDefinition, nodes = workflow.nodes, edges = workflow.edges): string {
  return stringify(envelope('Canvas', `${workflow.id}-layout`, workflow.version, workflow.name, {
    workflowId: `Workflow/${workflow.id}`,
    nodes: nodes.map((node) => ({ id: node.id, position: node.position })),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target, ...(edge.condition === undefined ? {} : { condition: edge.condition }) })),
  }));
}

/** Apply a file-backed Canvas projection without changing workflow semantics. */
export function applyCanvasResource(workflow: WorkflowDefinition, source: string): WorkflowDefinition {
  const parsed = parse(source) as unknown;
  if (parsed === null || typeof parsed !== 'object') return workflow;
  const document = parsed as { kind?: unknown; spec?: unknown };
  if (document.kind !== 'Canvas' || document.spec === null || typeof document.spec !== 'object') return workflow;
  const spec = document.spec as { workflowId?: unknown; nodes?: unknown; edges?: unknown };
  const workflowId = typeof spec.workflowId === 'string' ? spec.workflowId.replace(/^Workflow\//, '') : undefined;
  if (workflowId !== workflow.id) return workflow;
  const positions = new Map(
    (Array.isArray(spec.nodes) ? spec.nodes : [])
      .filter((node): node is { id: string; position: { x: number; y: number } } =>
        node !== null && typeof node === 'object'
        && typeof (node as { id?: unknown }).id === 'string'
        && (node as { position?: unknown }).position !== null
        && typeof (node as { position?: unknown }).position === 'object'
        && typeof ((node as { position: { x?: unknown } }).position.x) === 'number'
        && typeof ((node as { position: { y?: unknown } }).position.y) === 'number',
      )
      .map((node) => [node.id, node.position] as const),
  );
  const conditions = new Map(
    (Array.isArray(spec.edges) ? spec.edges : [])
      .filter((edge): edge is { source: string; target: string; condition?: string } =>
        edge !== null && typeof edge === 'object'
        && typeof (edge as { source?: unknown }).source === 'string'
        && typeof (edge as { target?: unknown }).target === 'string',
      )
      .map((edge) => [`${edge.source}\u0000${edge.target}`, edge.condition] as const),
  );
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const position = positions.get(node.id);
      return position === undefined ? node : { ...node, position: { ...position } };
    }),
    edges: workflow.edges.map((edge) => {
      const condition = conditions.get(`${edge.source}\u0000${edge.target}`);
      return condition === undefined ? edge : { ...edge, condition };
    }),
  };
}

/** Build a stable file-backed representation without mutating storage. */
export function planResourceMigration(project: ProjectRecord, workflows: WorkflowDefinition[]): ResourceMigrationPlan {
  const files: MigrationResourceFile[] = [];
  const agents = new Map(workflows.flatMap((workflow) => workflow.agents).map((agent) => [agent.id, agent]));
  for (const agent of [...agents.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const { id: _id, version, name: _name, ...spec } = agent;
    files.push(file(`agents/${agent.id}.agent.yaml`, envelope('Agent', agent.id, version, agent.name, spec)));
  }
  const units = new Map<string, WorkflowDefinition['nodes'][number]['unit']>();
  for (const workflow of [...workflows].sort((left, right) => left.id.localeCompare(right.id))) {
    const steps = workflow.nodes
      .filter((node) => node.type !== workflow.trigger.type)
      .map((node) => {
        const unitId = node.unit === undefined ? undefined : `unit-${workflow.id}-${node.id}`;
        if (unitId !== undefined) units.set(unitId, node.unit);
        return {
          id: node.id,
          name: node.label,
          type: node.type,
          config: node.config,
          ...(typeof node.config.agentId === 'string' ? { agent: node.config.agentId } : {}),
          ...(typeof node.config.goal === 'string' ? { goal: node.config.goal } : {}),
          ...(typeof node.config.maxIterations === 'number' ? { maxIterations: node.config.maxIterations } : {}),
          ...(unitId === undefined ? {} : { unit: `WorkUnit/${unitId}` }),
        };
      });
    files.push(file(`workflows/${workflow.id}.workflow.yaml`, envelope('Workflow', workflow.id, workflow.version, workflow.name, {
      description: workflow.description,
      trigger: workflow.trigger.type.replace(/Trigger$/, '').toLowerCase(),
      ...(workflow.inputSchema === undefined ? {} : { inputSchema: workflow.inputSchema }),
      steps,
      edges: workflow.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
        ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
        ...(edge.condition === undefined ? {} : { condition: edge.condition }),
      })),
    })));
    files.push({ path: `canvas/${workflow.id}.canvas.yaml`, source: renderCanvasResource(workflow) });
  }
  for (const [unitId, unit] of [...units.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (unit !== undefined) files.push(file(`units/${unitId}.unit.yaml`, envelope('WorkUnit', unitId, unit.version, undefined, unit as unknown as Record<string, unknown>)));
  }
  const resourcePaths = files.map((item) => item.path).sort();
  files.push(file('factory.yaml', envelope('Project', project.id, 1, project.name, {
    description: project.description,
    resources: resourcePaths,
  })));
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    sourceProjectId: project.id,
    sourceWorkflowIds: workflows.map((workflow) => workflow.id).sort(),
    sourceAgentIds: [...agents.keys()].sort(),
  };
}
