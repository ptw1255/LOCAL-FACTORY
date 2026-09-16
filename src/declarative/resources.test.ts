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

  it('validates the extended declarative resource vocabulary without mixing in runtime state', () => {
    const resources = [
      { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\nspec: {}' },
      { path: 'policies/default.policy.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Policy\nmetadata:\n  id: default\n  version: 1\nspec:\n  rules:\n    - effect: allow' },
      { path: 'connections/github.connection.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Connection\nmetadata:\n  id: github\n  version: 1\nspec:\n  connector: GitHub\n  environment: local\n  secretRef: vault://local/github' },
      { path: 'environments/local.environment.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Environment\nmetadata:\n  id: local\n  version: 1\nspec:\n  name: local\n  overrides:\n    workflows:\n      review:\n        description: Local review\n    agents:\n      reviewer:\n        limits:\n          maxIterations: 5' },
      { path: 'schemas/request.schema.json', source: 'apiVersion: factory.agentic/v1\nkind: Schema\nmetadata:\n  id: request\n  version: 1\nspec:\n  type: object\n  properties:\n    request:\n      type: string' },
      { path: 'canvas/review.canvas.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Canvas\nmetadata:\n  id: review-layout\n  version: 1\nspec:\n  workflowId: review\n  nodes:\n    - id: trigger\n      position: { x: 0, y: 0 }' },
      { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: done\n      type: output\n      policy: default\n      connection: github\n      config: {}' },
    ];
    const result = compileResourceFiles(resources, { tenantId: 'tenant-local', projectId: 'project-local', environment: 'local' });
    expect(result.resources.map((resource) => resource.kind)).toEqual(expect.arrayContaining(['Policy', 'Connection', 'Environment', 'Schema', 'Canvas']));
    expect(result.workflows[0]?.description).toBe('Local review');
    expect(result.workflows[0]?.nodes[1]?.config).toEqual(expect.objectContaining({ policyId: 'default', connectionId: 'github' }));
    expect(() => parseResourceFile({ path: 'connections/bad.connection.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Connection\nmetadata:\n  id: bad\n  version: 1\nspec:\n  connector: GitHub\n  environment: local\n  apiKey: plaintext' })).toThrow(/secret reference/);
  });

  it('rejects unresolved Canvas and workflow references by stable resource identity', () => {
    const project = { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\nspec: {}' };
    const workflow = { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: done\n      type: output' };
    const canvas = { path: 'canvas/review.canvas.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Canvas\nmetadata:\n  id: layout\n  version: 1\nspec:\n  workflowId: missing' };
    expect(() => compileResourceFiles([project, workflow, canvas], { tenantId: 'tenant-local' })).toThrow(/missing Workflow\/missing/);
  });

  it('resolves schema references and rejects dependency cycles', () => {
    const project = { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\nspec: {}' };
    const schema = { path: 'schemas/request.schema.json', source: 'apiVersion: factory.agentic/v1\nkind: Schema\nmetadata:\n  id: request\n  version: 1\nspec:\n  type: object\n  required: [goal]' };
    const agent = { path: 'agents/reviewer.agent.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: reviewer\n  version: 1\n  name: Reviewer\nspec:\n  inputSchema: $ref:request\n  purpose: Review\n  instructions: Review\n  skills: []\n  tools: []\n  model: { routingAlias: default-safe }' };
    const workflow = { path: 'workflows/review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  inputSchema:\n    $ref: Schema/request\n  steps:\n    - id: first\n      type: output\n      dependsOn: [second]\n    - id: second\n      type: output\n      dependsOn: [first]' };
    expect(() => compileResourceFiles([project, schema, agent, workflow], { tenantId: 'tenant-local' })).toThrow(/reference cycle/);
    const acyclic = { ...workflow, source: workflow.source.replace('      dependsOn: [first]', '      dependsOn: []') };
    const result = compileResourceFiles([project, schema, agent, acyclic], { tenantId: 'tenant-local' });
    expect(result.workflows[0]?.inputSchema).toEqual({ type: 'object', required: ['goal'] });
    expect(result.workflows[0]?.agents[0]?.inputSchema).toEqual({ type: 'object', required: ['goal'] });
  });

  it('enforces the conventional path for each resource kind', () => {
    expect(() => compileResourceFiles([
      { path: 'factory.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: demo\n  version: 1\nspec: {}' },
      { path: 'review.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  steps:\n    - id: done\n      type: output' },
    ], { tenantId: 'tenant-local' })).toThrow(/conventional file path/);
  });

  it('includes file, line, and field path for envelope errors', () => {
    expect(() => parseResourceFile({ path: 'workflows/bad.workflow.yaml', source: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: bad\n  version: 1\nspec:\n  steps: []' })).toThrow(/workflows\/bad\.workflow\.yaml:7: spec\.steps/);
  });
});
