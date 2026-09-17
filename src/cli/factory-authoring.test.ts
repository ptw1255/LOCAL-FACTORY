import { describe, expect, it } from 'vitest';

import {
  addProjectResourcePaths,
  authoringSlug,
  canvasResourcePath,
  renderStarterCanvasFile,
  renderStarterWorkflowFile,
  renderWorkspaceProjectFile,
  workflowResourcePath,
} from '../../scripts/factory-authoring.js';
import { compileResourceFiles } from '../declarative/resources.js';

describe('FACTORY terminal authoring resources', () => {
  it('creates stable identifiers and resource paths', () => {
    expect(authoringSlug(' Review & Ship ', 'workflow')).toBe('review-ship');
    expect(authoringSlug('***', 'workflow')).toBe('workflow');
    expect(workflowResourcePath('review')).toBe('workflows/review.workflow.yaml');
    expect(canvasResourcePath('review')).toBe('canvas/review.canvas.yaml');
  });

  it('creates a workspace and a compilable starter workflow', () => {
    const workflowPath = workflowResourcePath('review');
    const canvasPath = canvasResourcePath('review');
    const project = addProjectResourcePaths(
      renderWorkspaceProjectFile('project-test', 'Test workspace', 'Terminal-authored project'),
      [workflowPath, canvasPath],
    );
    const compiled = compileResourceFiles([
      { path: 'factory.yaml', source: project },
      { path: workflowPath, source: renderStarterWorkflowFile('review', 'Review') },
      { path: canvasPath, source: renderStarterCanvasFile('review', 'Review') },
    ], { tenantId: 'tenant-test', projectId: 'project-test', environment: 'local' });

    expect(compiled.project).toMatchObject({ id: 'project-test', name: 'Test workspace' });
    expect(compiled.workflows).toHaveLength(1);
    expect(compiled.workflows[0]).toMatchObject({ id: 'review', name: 'Review', version: 1 });
    expect(compiled.workflows[0]?.nodes.map((node) => node.id)).toEqual(['trigger', 'output']);
    expect(compiled.workflows[0]?.edges).toEqual([expect.objectContaining({ source: 'trigger', target: 'output' })]);
  });

  it('updates resource paths without duplicates while retaining the document', () => {
    const project = renderWorkspaceProjectFile('project-test', 'Test workspace');
    const first = addProjectResourcePaths(project, ['workflows/review.workflow.yaml']);
    const second = addProjectResourcePaths(first, ['canvas/review.canvas.yaml', 'workflows/review.workflow.yaml']);
    expect(second).toContain('name: Test workspace');
    expect(second.match(/workflows\/review\.workflow\.yaml/g)).toHaveLength(1);
    expect(second).toContain('canvas/review.canvas.yaml');
  });
});
