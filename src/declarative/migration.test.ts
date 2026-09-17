import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { createSeedState, seedWorkflow } from '../domain/seed.js';
import { applyCanvasResource, patchWorkUnitResource, patchWorkflowResource, planResourceMigration, renderCanvasResource, renderWorkUnitResource, workUnitResourceId } from './migration.js';

describe('resource migration planner', () => {
  it('creates stable project, agent, workflow, unit, and Canvas files', () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'review';
    workflow.agents[0]!.id = 'reviewer';
    const project = createSeedState().projects[0]!;
    const plan = planResourceMigration(project, [workflow]);
    expect(plan.files.map((item) => item.path)).toEqual([
      'agents/reviewer.agent.yaml',
      'canvas/review.canvas.yaml',
      'factory.yaml',
      'units/unit-review-agent.unit.yaml',
      'units/unit-review-notify.unit.yaml',
      'units/unit-review-output.unit.yaml',
      'units/unit-review-prepare.unit.yaml',
      'workflows/review.workflow.yaml',
    ]);
    expect(plan.files.find((item) => item.path === 'workflows/review.workflow.yaml')?.source).toContain('unit: WorkUnit/unit-review-agent');
    expect(plan.files.find((item) => item.path === 'canvas/review.canvas.yaml')?.source).toContain('workflowId: Workflow/review');
    const parsedProject = parse(plan.files.find((item) => item.path === 'factory.yaml')?.source ?? '') as { spec?: { resources?: string[] } };
    expect(parsedProject.spec?.resources).toEqual(plan.files.filter((item) => item.path !== 'factory.yaml').map((item) => item.path).sort());
  });

  it('is idempotent and preserves source identities', () => {
    const workflow = structuredClone(seedWorkflow);
    const project = createSeedState().projects[0]!;
    const first = planResourceMigration(project, [workflow]);
    const second = planResourceMigration(project, [workflow]);
    expect(second).toEqual(first);
    expect(first.sourceProjectId).toBe(project.id);
    expect(first.sourceWorkflowIds).toEqual([seedWorkflow.id]);
  });

  it('hydrates a workflow from its Canvas layout projection', () => {
    const workflow = structuredClone(seedWorkflow);
    const source = renderCanvasResource(workflow, [
      { ...workflow.nodes[0]!, position: { x: 321, y: 123 } },
      ...workflow.nodes.slice(1),
    ], workflow.edges.map((edge) => ({ ...edge, condition: edge.id === workflow.edges[0]?.id ? 'approved' : undefined })));
    const hydrated = applyCanvasResource(workflow, source);
    expect(hydrated.nodes[0]?.position).toEqual({ x: 321, y: 123 });
    expect(hydrated.edges[0]?.condition).toBe('approved');
    expect(hydrated.nodes[0]).not.toBe(workflow.nodes[0]);
    expect(applyCanvasResource(workflow, renderCanvasResource({ ...workflow, id: 'other' }))).toBe(workflow);
  });

  it('patches semantic Canvas edits into workflow YAML while retaining unrelated comments', () => {
    const workflow = structuredClone(seedWorkflow);
    const project = createSeedState().projects[0]!;
    const original = planResourceMigration(project, [workflow]).files.find((item) => item.path === `workflows/${workflow.id}.workflow.yaml`)?.source;
    expect(original).toBeDefined();
    const source = `# keep this file header\n${original ?? ''}\n# keep this footer\n`;
    const next = structuredClone(workflow);
    next.version += 1;
    next.nodes = next.nodes.filter((node) => node.id !== 'notify');
    next.edges = next.edges.filter((edge) => edge.source !== 'notify' && edge.target !== 'notify');
    next.nodes.find((node) => node.id === 'agent')!.label = 'Review request';
    const patched = patchWorkflowResource(source, next);
    expect(patched).toContain('# keep this file header');
    expect(patched).toContain('# keep this footer');
    expect(patched).toContain('name: Review request');
    expect(patched).not.toContain('id: notify');
    expect(patched).toContain(`unit: WorkUnit/${workUnitResourceId(workflow.id, 'agent')}`);
    expect(patched).toContain(`id: ${next.edges[0]?.id}`);
  });

  it('patches WorkUnit modules without dropping authored comments', () => {
    const unit = structuredClone(seedWorkflow.nodes.find((node) => node.unit !== undefined)?.unit)!;
    const source = `# unit policy\n${renderWorkUnitResource('unit-review', unit)}# end\n`;
    const patched = patchWorkUnitResource(source, { ...unit, retryAttempts: unit.retryAttempts + 1 });
    expect(patched).toContain('# unit policy');
    expect(patched).toContain('# end');
    expect(patched).toContain(`retryAttempts: ${unit.retryAttempts + 1}`);
    const withoutOptional = patchWorkUnitResource(patched, { ...unit, idempotencyKey: undefined, compensation: undefined });
    expect(withoutOptional).not.toContain('idempotencyKey:');
    expect(withoutOptional).not.toContain('compensation:');
  });
});
