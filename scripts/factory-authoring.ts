import { parseDocument, stringify } from 'yaml';

const apiVersion = 'factory.agentic/v1';

export function authoringSlug(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

export function workflowResourcePath(workflowId: string): string {
  return `workflows/${workflowId}.workflow.yaml`;
}

export function canvasResourcePath(workflowId: string): string {
  return `canvas/${workflowId}.canvas.yaml`;
}

export function renderWorkspaceProjectFile(projectId: string, name: string, description = ''): string {
  return stringify({
    apiVersion,
    kind: 'Project',
    metadata: { id: projectId, version: 1, name },
    spec: { description, resources: [] },
  });
}

export function renderStarterWorkflowFile(workflowId: string, name: string): string {
  return stringify({
    apiVersion,
    kind: 'Workflow',
    metadata: { id: workflowId, version: 1, name },
    spec: {
      description: `${name} workflow`,
      trigger: 'manual',
      steps: [
        {
          id: 'output',
          name: 'Return result',
          type: 'output',
          config: { value: 'success' },
        },
      ],
      edges: [{ id: 'edge-trigger-output', source: 'trigger', target: 'output' }],
    },
  });
}

export function renderStarterCanvasFile(workflowId: string, name: string): string {
  return stringify({
    apiVersion,
    kind: 'Canvas',
    metadata: { id: `${workflowId}-layout`, version: 1, name },
    spec: {
      workflowId: `Workflow/${workflowId}`,
      nodes: [
        { id: 'trigger', position: { x: 40, y: 180 } },
        { id: 'output', position: { x: 300, y: 180 } },
      ],
      edges: [{ source: 'trigger', target: 'output' }],
    },
  });
}

export function addProjectResourcePaths(source: string, resourcePaths: readonly string[]): string {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error(document.errors[0]?.message ?? 'Invalid Project YAML.');
  if (document.get('kind') !== 'Project') throw new Error('factory.yaml must contain a Project resource.');
  const parsed = document.toJS() as { spec?: { resources?: unknown } };
  const current = Array.isArray(parsed.spec?.resources)
    ? parsed.spec.resources.filter((item): item is string => typeof item === 'string')
    : [];
  document.setIn(['spec', 'resources'], [...new Set([...current, ...resourcePaths])].sort());
  return document.toString();
}
