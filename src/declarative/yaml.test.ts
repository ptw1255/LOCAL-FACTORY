import { describe, expect, it } from 'vitest';

import { DeclarativeSourceError, parseProjectYaml, stringifyProjectYaml } from './yaml.js';

const source = `
apiVersion: factory.agentic/v1
kind: Project
metadata:
  id: project-test
  name: Test loop
  description: A declarative test loop.
agents:
  - id: reviewer
    name: Reviewer
    purpose: Review the supplied change.
    instructions: Return a concise risk assessment.
    skills: [code-review]
    tools: []
    model:
      provider: openai
      model: gpt-test
      routing:
        strategy: fallback
        maxAttempts: 2
      routes:
        - provider: openai
          model: gpt-test
        - provider: ollama
          model: llama3.2
    boundaries:
      allowedConnections: []
      allowedRepositories: []
      protectedPaths: []
      network: deny-by-default
      dataClasses: [internal]
    limits:
      maxIterations: 2
      maxCostUsd: 0.1
      maxDurationMs: 30000
    termination:
      successConditions: [Review is complete.]
      failureConditions: []
      escalationConditions: []
    approval:
      beforeSideEffects: false
      beforeTools: []
    observability:
      captureInputs: false
      captureOutputs: false
      redactedFields: [prompt, output]
workflows:
  - id: workflow-test
    name: Test workflow
    trigger: manual
    steps:
      - id: prepare
        name: Prepare
        kind: deterministic
        operation: trim
      - id: review
        name: Review
        kind: agent
        agent: reviewer
`;

describe('declarative project YAML', () => {
  it('returns source location diagnostics for YAML syntax errors', () => {
    try {
      parseProjectYaml('apiVersion: [\n', { tenantId: 'tenant-test' });
      throw new Error('expected parse to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DeclarativeSourceError);
      expect((error as DeclarativeSourceError).diagnostics).toEqual([expect.objectContaining({ path: 'project.yaml', line: 2, column: 1, code: 'yaml.parse' })]);
    }
  });

  it('anchors schema diagnostics to the authored YAML node', () => {
    try {
      parseProjectYaml('apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  name: 42\n', { tenantId: 'tenant-test' });
      throw new Error('expected schema validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DeclarativeSourceError);
      expect((error as DeclarativeSourceError).diagnostics).toEqual([expect.objectContaining({ path: 'project.yaml', line: 4, column: 9, code: 'yaml.schema' })]);
    }
  });

  it('parses a project into validated runtime definitions', () => {
    const parsed = parseProjectYaml(source, { tenantId: 'tenant-test' });
    expect(parsed.project).toMatchObject({ id: 'project-test', tenantId: 'tenant-test', name: 'Test loop' });
    expect(parsed.workflows).toHaveLength(1);
    expect(parsed.workflows[0]).toMatchObject({
      id: 'workflow-test',
      projectId: 'project-test',
      trigger: { type: 'manualTrigger' },
    });
    expect(parsed.workflows[0]?.nodes.map((node) => node.type)).toEqual([
      'manualTrigger',
      'code',
      'agentLoop',
    ]);
    expect(parsed.workflows[0]?.agents[0]?.model.model).toBe('gpt-test');
    expect(parsed.workflows[0]?.agents[0]?.model.routing).toEqual({ strategy: 'fallback', maxAttempts: 2 });
    expect(parsed.workflows[0]?.agents[0]?.model.routes).toEqual([
      { provider: 'openai', model: 'gpt-test' },
      { provider: 'ollama', model: 'llama3.2' },
    ]);
  });

  it('round-trips runtime definitions back to source YAML', () => {
    const parsed = parseProjectYaml(source, { tenantId: 'tenant-test' });
    const rendered = stringifyProjectYaml(parsed.project, parsed.workflows);
    expect(rendered).toContain('apiVersion: factory.agentic/v1');
    expect(rendered).toContain('kind: Project');
    expect(rendered).toContain('name: Test workflow');
    expect(rendered).toContain('type: agentLoop');
  });

  it('preserves explicit workflow edges when compiling resource files', () => {
    const parsed = parseProjectYaml(`${source}\n`, { tenantId: 'tenant-test' });
    const explicit = parseProjectYaml(source.replace(
      '  - id: prepare\n',
      '  - id: prepare\n',
    ).replace(
      '      - id: review\n        name: Review\n        kind: agent\n        agent: reviewer\n',
      '      - id: review\n        name: Review\n        kind: agent\n        agent: reviewer\n    edges:\n      - id: edge-review-prepare\n        source: review\n        target: prepare\n        condition: retry\n',
    ), { tenantId: 'tenant-test' });
    expect(parsed.workflows[0]?.edges).toHaveLength(2);
    expect(explicit.workflows[0]?.edges).toEqual([
      { id: 'edge-review-prepare', source: 'review', target: 'prepare', condition: 'retry' },
    ]);
  });

  it('rejects unsupported document headers and node types', () => {
    expect(() => parseProjectYaml(source.replace('kind: Project', 'kind: Workflow'), { tenantId: 'tenant-test' })).toThrow(/kind/);
    expect(() => parseProjectYaml(source.replace('kind: deterministic', 'type: unsupported'), { tenantId: 'tenant-test' })).toThrow(/Unknown YAML step type/);
  });
});
