import { describe, expect, it } from 'vitest';
import { compileResourceFiles, parseResourceFile } from './resources.js';

describe('typed resource files', () => {
  it('compiles Project, Agent, and Workflow envelopes', () => {
    const result = compileResourceFiles([
      { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  name: Demo\nspec: {}' },
      { path: 'agents/reviewer.agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: reviewer\n  version: 1\n  name: Reviewer\nspec:\n  purpose: Review\n  instructions: Review the change\n  skills: []\n  tools: []\n  model: { routingAlias: default-safe }' },
      { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: review\n      kind: agent\n      agent: reviewer' },
    ], { tenantId: 'tenant-local' });
    expect(result.project.id).toBe('demo');
    expect(result.workflows[0]?.agents[0]?.id).toBe('reviewer');
  });

  it('rejects runtime state and secret values', () => {
    expect(() => parseResourceFile({ path: 'agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: a\n  status: live\nspec: {}' })).toThrow(/runtime state/);
    expect(() => parseResourceFile({ path: 'agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: a\nspec:\n  apiKey: secret-value' })).toThrow(/secret reference/);
  });

  it('anchors unknown work-unit diagnostics to the authored workflow file', () => {
    expect(() => compileResourceFiles([
      { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  name: Demo\nspec: {}' },
      { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: invalid\n      type: code\n      unit:\n        kind: unsupported\n        version: 1\n        inputSchema: any\n        outputSchema: any\n        timeoutMs: 1000\n        retryAttempts: 1' },
    ], { tenantId: 'tenant-local' })).toThrow(/workflows\/review\.workflow\.yaml:.*invalid/i);
  });
});
