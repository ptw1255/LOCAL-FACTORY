import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import { planCompensations } from './workflows.js';

describe('Temporal compensation planning', () => {
  it('creates a deterministic reverse-order plan from completed units', () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    const agent = workflow.nodes.find((node) => node.id === 'agent');
    if (prepare === undefined || agent === undefined) throw new Error('Seed nodes are missing.');
    prepare.unit = {
      ...defaultWorkUnit('repositoryMutation'),
      compensation: { nodeType: 'repositoryMutation', config: { capabilities: ['repository.write'], operations: [] }, idempotencyKey: 'prepare:compensate:v1' },
    };
    agent.unit = {
      ...defaultWorkUnit('repositoryCommit'),
      compensation: { nodeType: 'repositoryBranch', config: { branch: 'factory/recovery' }, idempotencyKey: 'agent:compensate:v1' },
    };
    const first = planCompensations(workflow, ['trigger', 'prepare', 'agent']);
    const second = planCompensations(workflow, ['trigger', 'prepare', 'agent']);
    expect(first).toEqual(second);
    expect(first).toEqual([
      { sourceNodeId: 'agent', nodeId: 'agent:compensate', nodeType: 'repositoryBranch', config: { branch: 'factory/recovery' }, idempotencyKey: 'agent:compensate:v1' },
      { sourceNodeId: 'prepare', nodeId: 'prepare:compensate', nodeType: 'repositoryMutation', config: { capabilities: ['repository.write'], operations: [] }, idempotencyKey: 'prepare:compensate:v1' },
    ]);
  });

  it('omits completed units without compensation metadata', () => {
    expect(planCompensations(seedWorkflow, ['trigger', 'prepare', 'missing'])).toEqual([]);
  });
});
