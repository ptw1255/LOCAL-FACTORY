import { describe, expect, it } from 'vitest';

import type { WorkflowNode } from '../domain/types.js';
import { bindWorkflowNode, deliveryActionPlanHash, validateDeliveryActionPlan, type DeliveryActionPlan } from './delivery-action-plan.js';

const plan: DeliveryActionPlan = {
  version: 1,
  issue: { number: 42, title: 'Make the change', repository: 'acme/factory' },
  repository: { owner: 'acme', name: 'factory', baseRevision: '0123456789abcdef0123456789abcdef01234567' },
  tasks: [{ id: 'implement', title: 'Implement the change' }],
  mutations: [{ operation: 'replace', path: 'src/example.ts', content: 'export const answer = 42;\n' }],
  checks: ['npm run typecheck'],
  branch: { name: 'factory/issue-42' },
  commit: { message: 'Implement issue 42', paths: ['src/example.ts'] },
  pullRequest: { title: 'Implement issue 42', body: 'Resolves #42', base: 'main' },
  source: { agentId: 'luna-executor', model: 'gpt-5.6-luna', artifactId: 'artifact-1' },
  policyVersion: 'delivery-v1',
};

describe('DeliveryActionPlan', () => {
  it('validates safe plans and produces a stable hash', () => {
    const validated = validateDeliveryActionPlan(plan);
    expect(validated).toEqual(plan);
    expect(deliveryActionPlanHash(validated)).toHaveLength(64);
    expect(deliveryActionPlanHash(validateDeliveryActionPlan(structuredClone(plan)))).toBe(deliveryActionPlanHash(validated));
  });

  it('rejects unsafe paths, unknown dependencies, and mismatched repositories', () => {
    expect(() => validateDeliveryActionPlan({ ...plan, mutations: [{ operation: 'replace', path: '../secrets.txt', content: 'nope' }] })).toThrow(/safe relative path/);
    expect(() => validateDeliveryActionPlan({ ...plan, tasks: [{ id: 'implement', title: 'Implement', dependsOn: ['missing'] }] })).toThrow(/unknown task/);
    expect(() => validateDeliveryActionPlan({ ...plan, issue: { ...plan.issue, repository: 'other/repo' } })).toThrow(/must match/);
    expect(() => validateDeliveryActionPlan({ ...plan, checks: ['curl https://example.test'] })).toThrow(/unsupported command/);
    expect(() => validateDeliveryActionPlan({ ...plan, commit: { ...plan.commit, paths: [] } })).toThrow(/include every delivery mutation path/);
  });

  it('binds only explicit context paths and preserves object values for exact bindings', () => {
    const node: WorkflowNode = {
      id: 'mutate',
      type: 'repositoryMutation',
      label: 'Apply plan',
      position: { x: 0, y: 0 },
      unit: { kind: 'deterministic', version: 1, inputSchema: 'any', outputSchema: 'any', timeoutMs: 1_000, retryAttempts: 0 },
      config: {
        issue: '{{issue.number}}',
        repository: '{{repository.owner}}/{{repository.name}}',
        deliveryActionPlan: '{{plan}}',
      },
    };
    const bound = bindWorkflowNode(node, { plan, issue: plan.issue, repository: plan.repository, input: { issueNumber: 42 } });
    expect(bound.config.issue).toBe(42);
    expect(bound.config.repository).toBe('acme/factory');
    expect(bound.config.deliveryActionPlan).toEqual(plan);
    expect(() => bindWorkflowNode(node, { issue: plan.issue })).toThrow(/could not be resolved|allowed context path/);
  });
});
