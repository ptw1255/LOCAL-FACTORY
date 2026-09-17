import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { planResourceMigration } from '../declarative/migration.js';
import { createSeedState, seedWorkflow } from '../domain/seed.js';
import type { ProjectFileRecord } from '../domain/types.js';
import { createAuthoringChanges, planWorkflowAuthoringChanges, validateAuthoringChanges } from './authoring.js';
import { ProposalService } from './proposal-service.js';

function fileRecords(): ProjectFileRecord[] {
  const project = createSeedState().projects[0]!;
  return planResourceMigration(project, [seedWorkflow]).files.map((file) => ({
    tenantId: project.tenantId,
    projectId: project.id,
    path: file.path,
    content: file.source,
    sha256: createHash('sha256').update(file.source).digest('hex'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

describe('AI Project authoring', () => {
  it('turns a workflow goal into compilable resource-envelope changes', () => {
    const project = createSeedState().projects[0]!;
    const currentFiles = fileRecords();
    const planned = new ProposalService({} as never).plan(seedWorkflow, 'Add human approval before notifying the operator');
    const changes = planWorkflowAuthoringChanges(project, planned.workflow, currentFiles);

    expect(changes.some((change) => change.path === 'factory.yaml')).toBe(true);
    expect(changes.some((change) => change.path.endsWith('.workflow.yaml'))).toBe(true);
    expect(changes.some((change) => change.path.endsWith('.unit.yaml'))).toBe(true);
    expect(validateAuthoringChanges(currentFiles, changes, { tenantId: project.tenantId, projectId: project.id })).toEqual({ valid: true, issues: [] });
    expect(new ProposalService({} as never).plan(seedWorkflow, planned.goal).workflow.nodes.map((node) => node.id)).toEqual(planned.workflow.nodes.map((node) => node.id));
  });

  it('rejects a stale proposal before any file is applied', () => {
    const currentFiles = fileRecords();
    const workflow = currentFiles.find((file) => file.path.endsWith('.workflow.yaml'))!;
    const changes = createAuthoringChanges(currentFiles, [{ path: workflow.path, content: `${workflow.content}\n# proposed change\n` }]);
    const changedCurrent = currentFiles.map((file) => file.path === workflow.path ? { ...file, sha256: 'changed-after-proposal' } : file);
    const validation = validateAuthoringChanges(changedCurrent, changes, { tenantId: workflow.tenantId, projectId: workflow.projectId });

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'authoring.conflict', path: workflow.path }));
  });
});
