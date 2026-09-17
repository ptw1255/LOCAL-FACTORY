import { parse, stringify } from 'yaml';

import type { ProjectRecord, WorkflowDefinition } from '../domain/types.js';

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
