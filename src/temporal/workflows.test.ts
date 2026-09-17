import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import type { AgentDefinition } from '../domain/types.js';
import { isTemporalSideEffectingUnit, planCompensations, requiresTemporalApproval, temporalStatusSearchAttributes } from './workflows.js';

const toolAgent: AgentDefinition = {
  id: 'tool-agent', version: 1, name: 'Tool agent', purpose: 'Test', instructions: 'Test', skills: [], tools: ['repo.check'],
  model: { provider: 'ollama', model: 'test' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: [], allowedRepositories: [], protectedPaths: [], network: 'deny-by-default', dataClasses: ['internal'] },
  limits: { maxIterations: 2, maxCostUsd: 1, maxDurationMs: 60_000 }, termination: { successConditions: [], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: true, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
};

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

  it('marks connector and consumer WorkUnits as one-shot Temporal activities', () => {
    expect(isTemporalSideEffectingUnit(defaultWorkUnit('repositoryMutation'))).toBe(true);
    expect(isTemporalSideEffectingUnit(defaultWorkUnit('notification'))).toBe(true);
    expect(isTemporalSideEffectingUnit(defaultWorkUnit('code'))).toBe(false);
    expect(isTemporalSideEffectingUnit(undefined)).toBe(false);
  });

  it('applies the agent envelope approval policy in Temporal', () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.agents = [toolAgent];
    const node = workflow.nodes.find((candidate) => candidate.type === 'agentLoop');
    if (node === undefined) throw new Error('Agent node is missing.');
    node.config.agentId = toolAgent.id;
    expect(requiresTemporalApproval(node, workflow)).toBe(true);
    toolAgent.approval = { beforeSideEffects: false, beforeTools: [] };
    expect(requiresTemporalApproval(node, workflow)).toBe(false);
    toolAgent.approval = { beforeSideEffects: true, beforeTools: [] };
  });

  it('uses the stable Status search-attribute shape for lifecycle transitions', () => {
    expect(temporalStatusSearchAttributes('waiting')).toEqual({ CustomKeywordField: ['waiting'] });
    expect(temporalStatusSearchAttributes('succeeded')).toEqual({ CustomKeywordField: ['succeeded'] });
    expect(temporalStatusSearchAttributes('cancelled')).toEqual({ CustomKeywordField: ['cancelled'] });
  });
});
