import { stringify } from 'yaml';

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

/** Build a stable file-backed representation without mutating storage. */
export function planResourceMigration(project: ProjectRecord, workflows: WorkflowDefinition[]): ResourceMigrationPlan {
  const files: MigrationResourceFile[] = [file('factory.yaml', envelope('Project', project.id, 1, project.name, { description: project.description }))];
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
    files.push(file(`canvas/${workflow.id}.canvas.yaml`, envelope('Canvas', `${workflow.id}-layout`, workflow.version, workflow.name, {
      workflowId: `Workflow/${workflow.id}`,
      nodes: workflow.nodes.map((node) => ({ id: node.id, position: node.position })),
      edges: workflow.edges.map((edge) => ({ source: edge.source, target: edge.target, ...(edge.condition === undefined ? {} : { condition: edge.condition }) })),
    })));
  }
  for (const [unitId, unit] of [...units.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (unit !== undefined) files.push(file(`units/${unitId}.unit.yaml`, envelope('WorkUnit', unitId, unit.version, undefined, unit as unknown as Record<string, unknown>)));
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    sourceProjectId: project.id,
    sourceWorkflowIds: workflows.map((workflow) => workflow.id).sort(),
    sourceAgentIds: [...agents.keys()].sort(),
  };
}
