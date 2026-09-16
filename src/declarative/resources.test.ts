import { describe, expect, it } from 'vitest';
import { compileResourceFiles, parseResourceFile } from './resources.js';

describe('typed resource files', () => {
  it('compiles Project, Agent, and Workflow envelopes', () => {
    const result = compileResourceFiles([
      { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\n  name: Demo\nspec: {}' },
      { path: 'agents/reviewer.agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: reviewer\n  version: 1\n  name: Reviewer\nspec:\n  purpose: Review\n  instructions: Review the change\n  skills: []\n  tools: []\n  model: { routingAlias: default-safe }' },
      { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: review\n      kind: agent\n      agent: reviewer' },
    ], { tenantId: 'tenant-local' });
    expect(result.project.id).toBe('demo');
    expect(result.workflows[0]?.agents[0]?.id).toBe('reviewer');
    expect(result.workflows[0]?.nodes[1]).toEqual(expect.objectContaining({ sourcePath: 'workflows/review.workflow.yaml', sourceLine: 10 }));
  });

  it('rejects runtime state and secret values', () => {
    expect(() => parseResourceFile({ path: 'agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: a\n  version: 1\n  status: live\nspec: {}' })).toThrow(/runtime state/);
    expect(() => parseResourceFile({ path: 'agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: a\n  version: 1\nspec:\n  apiKey: secret-value' })).toThrow(/secret reference/);
    expect(() => parseResourceFile({ path: 'agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: a\n  version: 1\nspec:\n  model:\n    secretRef: vault://local/agent/a' })).not.toThrow();
  });

  it('anchors unknown work-unit diagnostics to the authored workflow file', () => {
    expect(() => compileResourceFiles([
      { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\n  name: Demo\nspec: {}' },
      { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: invalid\n      type: code\n      unit:\n        kind: unsupported\n        version: 1\n        inputSchema: any\n        outputSchema: any\n        timeoutMs: 1000\n        retryAttempts: 1' },
    ], { tenantId: 'tenant-local' })).toThrow(/workflows\/review\.workflow\.yaml:.*invalid/i);
  });

  it('resolves named WorkUnit references and rejects duplicate identities', () => {
    const project = { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\nspec: {}' };
    const workflow = { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  steps:\n    - id: normalize\n      type: code\n      unit: normalize-unit' };
    const unit = { path: 'units/normalize.unit.yaml', source: 'apiVersion: factory.agentic/v1\nkind: WorkUnit\nmetadata:\n  id: normalize-unit\n  version: 1\nspec:\n  kind: deterministic\n  version: 1\n  inputSchema: any\n  outputSchema: any\n  timeoutMs: 1000\n  retryAttempts: 1' };
    expect(compileResourceFiles([project, workflow, unit], { tenantId: 'tenant-local' }).workflows[0]?.nodes[1]?.unit?.kind).toBe('deterministic');
    expect(() => compileResourceFiles([project, workflow, unit, { ...unit, path: 'units/other.unit.yaml' }], { tenantId: 'tenant-local' })).toThrow(/duplicate resource identity WorkUnit\/normalize-unit/);
  });

  it('includes file, line, and field path for envelope errors', () => {
    expect(() => parseResourceFile({ path: 'workflows/bad.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: bad\n  version: 1\nspec:\n  steps: []' })).toThrow(/workflows\/bad\.workflow\.yaml:7: spec\.steps/);
  });
});
