import { describe, expect, it } from 'vitest';

import { createSeedState, seedWorkflow } from '../domain/seed.js';
import { planResourceMigration } from './migration.js';

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
});
