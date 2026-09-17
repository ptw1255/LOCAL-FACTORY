import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from './catalog.js';
import { seedWorkflow } from './seed.js';
import {
  agentDefinitionSchema,
  cloneWorkflowSchema,
  createConnectionSchema,
  createAuthoringProposalSchema,
  createProjectSchema,
  createProposalSchema,
  createTenantSchema,
  declarativeImportSchema,
  workflowDefinitionSchema,
  workflowEdgeSchema,
  workflowNodeSchema,
  workUnitSchema,
} from './schema.js';

describe('declarative resource schemas', () => {
  it('accepts the seeded workflow and every nested resource contract', () => {
    expect(workflowDefinitionSchema.parse(seedWorkflow)).toEqual(seedWorkflow);
    expect(agentDefinitionSchema.parse(seedWorkflow.agents[0])).toEqual(seedWorkflow.agents[0]);
    expect(workUnitSchema.parse(defaultWorkUnit('agentLoop'))).toEqual(defaultWorkUnit('agentLoop'));
    expect(workflowNodeSchema.parse(seedWorkflow.nodes[0])).toEqual(seedWorkflow.nodes[0]);
    expect(workflowEdgeSchema.parse(seedWorkflow.edges[0])).toEqual(seedWorkflow.edges[0]);
  });

  it('accepts bounded authoring request fixtures', () => {
    expect(createConnectionSchema.parse({ name: 'Source control', connector: 'GitHub', environment: 'local', scopes: ['contents:read'] }))
      .toEqual({ name: 'Source control', connector: 'GitHub', environment: 'local', scopes: ['contents:read'] });
    expect(createProposalSchema.parse({ goal: 'Review the latest workflow change', workflowId: seedWorkflow.id })).toEqual({ goal: 'Review the latest workflow change', workflowId: seedWorkflow.id });
    expect(createAuthoringProposalSchema.parse({ goal: 'Review the latest workflow change', workflowId: seedWorkflow.id })).toEqual({ goal: 'Review the latest workflow change', workflowId: seedWorkflow.id });
    expect(createAuthoringProposalSchema.safeParse({ goal: 'Create a reviewed workflow resource', changes: [{ path: 'workflows/review.workflow.yaml', content: 'kind: Workflow' }] }).success).toBe(true);
    expect(createTenantSchema.parse({ name: 'Local tenant' })).toEqual({ name: 'Local tenant' });
    expect(createProjectSchema.parse({ name: 'Review loop' })).toEqual({ name: 'Review loop', description: '' });
    expect(cloneWorkflowSchema.parse({ sourceWorkflowId: seedWorkflow.id })).toEqual({ sourceWorkflowId: seedWorkflow.id });
    expect(declarativeImportSchema.parse({ source: 'apiVersion: factory.agentic/v1' })).toEqual({ source: 'apiVersion: factory.agentic/v1' });
  });

  it('rejects malformed resource contracts at their safety boundaries', () => {
    expect(workUnitSchema.safeParse({ ...defaultWorkUnit('code'), retryAttempts: 11 }).success).toBe(false);
    expect(agentDefinitionSchema.safeParse({ ...seedWorkflow.agents[0], purpose: '' }).success).toBe(false);
    expect(workflowNodeSchema.safeParse({ ...seedWorkflow.nodes[0], position: { x: Number.NaN, y: 0 } }).success).toBe(false);
    expect(workflowEdgeSchema.safeParse({ ...seedWorkflow.edges[0], target: '' }).success).toBe(false);
    expect(createConnectionSchema.safeParse({ name: ' ', connector: 'GitHub', environment: 'local', scopes: [] }).success).toBe(false);
    expect(createProposalSchema.safeParse({ goal: 'too short', workflowId: seedWorkflow.id }).success).toBe(false);
    expect(createAuthoringProposalSchema.safeParse({ goal: 'This request has no target' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(declarativeImportSchema.safeParse({ source: '' }).success).toBe(false);
  });
});
