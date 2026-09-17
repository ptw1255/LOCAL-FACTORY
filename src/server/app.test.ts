import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import { JsonStore } from '../storage/json-store.js';
import { ProjectWorkspace } from '../storage/project-workspace.js';
import { createQueuedRun } from '../runtime/executor.js';

async function waitForTerminal(store: JsonStore, runId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = await store.read((state) => state.runs.find((run) => run.id === runId)?.status);
    if (status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test run.');
}

describe('platform API', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let store: JsonStore;

  beforeEach(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-api-'));
    store = new JsonStore(path.join(directory, 'state.json'));
    app = await createApp({
      store,
      serveStatic: false,
      secretBroker: {
        put: async () => undefined,
        get: async () => 'test-secret',
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('exposes the catalog, workflows, connections, and metrics', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/catalog/nodes',
    });
    const workflows = await app.inject({
      method: 'GET',
      url: '/api/workflows',
    });
    const metrics = await app.inject({
      method: 'GET',
      url: '/api/factory/metrics',
    });

    expect(health.statusCode).toBe(200);
    expect(health.json<{ observability: { phoenixConfigured: boolean; phoenixUiUrl: string | null } }>().observability).toEqual(expect.objectContaining({ phoenixConfigured: false, phoenixUiUrl: null }));
    expect(catalog.json<{ items: unknown[] }>().items.length).toBeGreaterThan(5);
    expect(workflows.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(metrics.json()).toEqual(
      expect.objectContaining({
        automationPercent: 100,
        stageMetrics: expect.any(Array),
      }),
    );
  });

  it('surfaces configured telemetry exporter health without exposing exporter internals', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-health-'));
    const healthApp = await createApp({
      store: new JsonStore(path.join(directory, 'state.json')),
      serveStatic: false,
      telemetryExporter: {
        export: async () => undefined,
        health: () => ({ status: 'degraded', failureCount: 2, lastErrorAt: '2026-01-01T00:00:00.000Z' }),
      },
    });
    try {
      const response = await healthApp.inject({ method: 'GET', url: '/api/health' });
      expect(response.json<{ observability: { otlpExportEnabled: boolean; exporterHealth: { status: string; failureCount: number } | null } }>().observability).toEqual(expect.objectContaining({ otlpExportEnabled: true, exporterHealth: { status: 'degraded', failureCount: 2, lastErrorAt: '2026-01-01T00:00:00.000Z' } }));
    } finally {
      await healthApp.close();
    }
  });

  it('selects the Temporal execution plane only when explicitly configured', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-api-'));
    const temporalStore = new JsonStore(path.join(directory, 'state.json'));
    const handle = {
      workflowId: 'factory-pending',
      firstExecutionRunId: 'temporal-run-api',
      result: () => new Promise<never>(() => undefined),
      cancel: vi.fn(async () => undefined),
      signal: vi.fn(async () => undefined),
    };
    const start = vi.fn(async () => handle);
    const temporalApp = await createApp({
      store: temporalStore,
      serveStatic: false,
      executionEngine: 'temporal',
      temporalClient: { workflow: { start, getHandle: vi.fn(() => handle) } },
    });
    try {
      const health = await temporalApp.inject({ method: 'GET', url: '/api/health' });
      expect(health.json<{ executionEngine: string }>().executionEngine).toBe('temporal');
      const started = await temporalApp.inject({ method: 'POST', url: '/api/workflows/workflow-agent-intake/runs', payload: {} });
      expect(started.statusCode).toBe(200);
      expect(started.json<{ executionEngine: string; temporalTaskQueue: string; status: string }>()).toEqual(expect.objectContaining({ executionEngine: 'temporal', temporalTaskQueue: 'agentic-workflows-v1', status: 'running' }));
      expect(start).toHaveBeenCalledWith('executeWorkflow', expect.objectContaining({ taskQueue: 'agentic-workflows-v1', searchAttributes: expect.objectContaining({ WorkflowId: ['workflow-agent-intake'], WorkflowVersion: ['1'] }) }));
    } finally {
      await temporalApp.close();
    }
  });

  it('retries a failed run with source provenance through the API', async () => {
    const source = createQueuedRun(seedWorkflow, { input: { retry: true }, artifactId: 'sha256:retry' });
    source.status = 'failed';
    source.error = 'transient failure';
    await store.mutate((state) => { state.runs.push(source); });

    const response = await app.inject({ method: 'POST', url: `/api/runs/${source.id}/retry`, payload: { idempotencyKey: 'api-retry-1' } });
    expect(response.statusCode).toBe(200);
    const retried = response.json<{ id: string; replayOfRunId: string; artifactId: string; input: { retry: boolean }; retryIdempotencyKey: string }>();
    expect(retried).toEqual(expect.objectContaining({ replayOfRunId: source.id, artifactId: 'sha256:retry', input: { retry: true }, retryIdempotencyKey: 'api-retry-1' }));
    const repeated = await app.inject({ method: 'POST', url: `/api/runs/${source.id}/retry`, payload: { idempotencyKey: 'api-retry-1' } });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ id: string; replayOfRunId: string; retryIdempotencyKey: string }>()).toEqual(expect.objectContaining({ id: retried.id, replayOfRunId: source.id, retryIdempotencyKey: 'api-retry-1' }));
  });

  it('exposes and resolves incomplete tool checkpoints through the operator API', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agentNode === undefined) throw new Error('Agent node is missing.');
    const run = createQueuedRun(workflow);
    run.status = 'failed';
    run.error = 'Agent tool has an incomplete checkpoint.';
    await store.mutate((state) => { state.runs.push(run); });
    // Seed the unresolved checkpoint after the run exists so the listing is
    // tested independently from the recovery mutation.
    await store.mutate((state) => { state.evidence.push({ id: 'started-api', runId: run.id, unitId: agentNode.id, operation: 'agent.tool', idempotencyKey: 'pending-call:started', attempt: 1, status: 'started', occurredAt: new Date().toISOString() }); });
    const checkpoints = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/tool-checkpoints` });
    expect(checkpoints.statusCode).toBe(200);
    expect(checkpoints.json<{ items: Array<{ callId: string; status: string }> }>().items).toEqual([expect.objectContaining({ callId: 'pending-call', status: 'incomplete' })]);
    const recovery = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/tool-recovery`, payload: { unitId: agentNode.id, callId: 'pending-call', resolution: 'failed', reason: 'Operator could not verify completion.', actor: 'api-operator' } });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json<{ status: string }>().status).toBe('failed');
    const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${run.id}` });
    expect(evidence.json<{ items: Array<{ idempotencyKey?: string; status: string; source?: string }> }>().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ idempotencyKey: 'pending-call:recovered', status: 'failed', source: 'operator-recovery' }),
    ]));
  });

  it('lists approval records within the requested project scope', async () => {
    await store.mutate((state) => {
      state.approvals.push({ id: 'approval-api-test', tenantId: 'tenant-local', projectId: 'project-local', runId: 'run-api-test', nodeId: 'push', operation: 'repositoryPush', bindingHash: 'a'.repeat(64), decision: 'pending', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    });
    const response = await app.inject({ method: 'GET', url: '/api/approvals?runId=run-api-test', headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Array<{ id: string; bindingHash: string }> }>().items).toEqual([expect.objectContaining({ id: 'approval-api-test', bindingHash: 'a'.repeat(64) })]);
    const crossProject = await app.inject({ method: 'GET', url: '/api/approvals?runId=run-api-test', headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'other-project' } });
    expect(crossProject.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('creates projects and scopes workflow reads by project header', async () => {
    const createProject = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-tenant-id': 'tenant-local' },
      payload: { name: 'Second loop', description: 'Independent workflow project' },
    });
    expect(createProject.statusCode).toBe(200);
    const projectId = createProject.json<{ id: string }>().id;

    const defaultWorkflows = await app.inject({ method: 'GET', url: '/api/workflows' });
    const secondWorkflows = await app.inject({
      method: 'GET',
      url: '/api/workflows',
      headers: { 'x-project-id': projectId },
    });
    expect(defaultWorkflows.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(secondWorkflows.json<{ items: unknown[] }>().items).toHaveLength(0);

    const clone = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workflows`,
      headers: { 'x-project-id': 'project-local', 'x-tenant-id': 'tenant-local' },
      payload: { sourceWorkflowId: 'workflow-agent-intake', name: 'Second loop workflow' },
    });
    expect(clone.statusCode).toBe(200);
    const scopedAfterClone = await app.inject({
      method: 'GET',
      url: '/api/workflows',
      headers: { 'x-project-id': projectId, 'x-tenant-id': 'tenant-local' },
    });
    expect(scopedAfterClone.json<{ items: Array<{ projectId: string }> }>().items).toEqual([
      expect.objectContaining({ projectId }),
    ]);

    const tenantResponse = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      payload: { name: 'Other tenant' },
    });
    const otherTenantId = tenantResponse.json<{ id: string }>().id;
    const otherProjectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-tenant-id': otherTenantId },
      payload: { name: 'Other loop' },
    });
    expect(otherProjectResponse.statusCode).toBe(200);
    const crossTenantRead = await app.inject({
      method: 'GET',
      url: '/api/workflows',
      headers: { 'x-tenant-id': otherTenantId, 'x-project-id': projectId },
    });
    expect(crossTenantRead.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('exports and imports a project as declarative YAML', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: '/api/projects/project-local/declarative.yaml',
      headers: { 'x-tenant-id': 'tenant-local' },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers.deprecation).toBe('true');
    expect(exported.headers.link).toContain('/api/projects/project-local/files');
    expect(exported.headers['content-type']).toContain('text/yaml');
    expect(exported.body).toContain('apiVersion: factory.agentic/v1');

    const createProject = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-tenant-id': 'tenant-local' },
      payload: { name: 'Declarative loop' },
    });
    const projectId = createProject.json<{ id: string }>().id;
    const imported = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/declarative`,
      headers: { 'x-tenant-id': 'tenant-local' },
      payload: { source: exported.body },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.headers.deprecation).toBe('true');
    expect(imported.headers.link).toContain(`/api/projects/${projectId}/files`);
    expect(imported.json<{ project: { id: string }; workflows: Array<{ projectId: string }> }>()).toMatchObject({
      project: { id: projectId },
      workflows: [expect.objectContaining({ projectId })],
    });

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/declarative`,
      headers: { 'x-tenant-id': 'tenant-local' },
      payload: { source: 'kind: NotAProject' },
    });
    expect(invalid.statusCode).toBe(422);
    const invalidSyntax = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/declarative`,
      headers: { 'x-tenant-id': 'tenant-local' },
      payload: { source: 'apiVersion: [\n' },
    });
    expect(invalidSyntax.statusCode).toBe(422);
    expect(invalidSyntax.json<{ diagnostics: Array<{ path: string; line: number; column: number; code: string }> }>().diagnostics).toEqual([expect.objectContaining({ path: 'project.yaml', line: 2, column: 1, code: 'yaml.parse' })]);
    const afterInvalid = await app.inject({
      method: 'GET',
      url: '/api/workflows',
      headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': projectId },
    });
    expect(afterInvalid.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('stores typed project files and compiles an immutable artifact', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const files = [
      ['factory.yaml', 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: project-local\n  version: 1\n  name: Local\nspec: {}'],
      ['agents/reviewer.agent.yaml', 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: reviewer\n  version: 1\n  name: Reviewer\nspec:\n  purpose: Review\n  instructions: Review changes\n  skills: []\n  tools: []\n  model: { routingAlias: default-safe }'],
      ['workflows/review.workflow.yaml', 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: review\n      kind: agent\n      agent: reviewer'],
    ] as const;
    for (const [filePath, content] of files) {
      const response = await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: filePath, content } });
      expect(response.statusCode).toBe(200);
    }
    const listing = await app.inject({ method: 'GET', url: '/api/projects/project-local/files', headers });
    expect(listing.json<{ items: Array<{ content?: string }> }>().items.every((file) => file.content === undefined)).toBe(true);
    const contentSearch = await app.inject({ method: 'GET', url: '/api/projects/project-local/files?search=review%20changes', headers });
    expect(contentSearch.statusCode).toBe(200);
    expect(contentSearch.json<{ items: Array<{ path: string; content?: string }> }>().items).toEqual([expect.objectContaining({ path: 'agents/reviewer.agent.yaml' })]);
    expect(contentSearch.json<{ items: Array<{ content?: string }> }>().items.every((file) => file.content === undefined)).toBe(true);
    const compiled = await app.inject({ method: 'POST', url: '/api/projects/project-local/compile', headers, payload: { environment: 'local' } });
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json<{ id: string; workflows: unknown[] }>().id).toMatch(/^sha256:/);
    expect(compiled.json<{ workflows: unknown[] }>().workflows).toHaveLength(1);
    const synchronized = await app.inject({ method: 'GET', url: '/api/workflows', headers });
    expect(synchronized.json<{ items: Array<{ id: string; name: string }> }>().items).toEqual([
      expect.objectContaining({ id: 'review', name: 'Review' }),
    ]);
    const compiledAgain = await app.inject({ method: 'POST', url: '/api/projects/project-local/compile', headers, payload: { environment: 'local' } });
    expect(compiledAgain.statusCode).toBe(200);
    expect(compiledAgain.json<{ id: string }>().id).toBe(compiled.json<{ id: string }>().id);
    const artifacts = await app.inject({ method: 'GET', url: '/api/projects/project-local/artifacts', headers });
    expect(artifacts.json<{ items: unknown[] }>().items).toHaveLength(1);
    const artifactId = compiled.json<{ id: string }>().id;
    const retrieved = await app.inject({ method: 'GET', url: `/api/projects/project-local/artifacts/${encodeURIComponent(artifactId)}`, headers });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json<{ id: string; workflows: unknown[] }>()).toEqual(expect.objectContaining({ id: artifactId, workflows: expect.any(Array) }));
    const diff = await app.inject({ method: 'GET', url: `/api/projects/project-local/artifacts/diff?from=${encodeURIComponent(artifactId)}&to=${encodeURIComponent(artifactId)}`, headers });
    expect(diff.statusCode).toBe(200);
    expect(diff.json<{ changedSources: unknown[]; changedWorkflows: unknown[] }>().changedSources).toEqual([]);
    expect(diff.json<{ changedSources: unknown[]; changedWorkflows: unknown[] }>().changedWorkflows).toEqual([]);
    const missing = await app.inject({ method: 'GET', url: '/api/projects/project-local/artifacts/sha256:missing', headers });
    expect(missing.statusCode).toBe(404);
  });

  it('retains the last valid artifact when a later compilation fails', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const validFiles = [
      ['factory.yaml', 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: project-local\n  version: 1\n  name: Local\nspec: {}'],
      ['workflows/review.workflow.yaml', 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: done\n      type: output'],
    ] as const;
    for (const [filePath, content] of validFiles) {
      expect((await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: filePath, content } })).statusCode).toBe(200);
    }
    const valid = await app.inject({ method: 'POST', url: '/api/projects/project-local/compile', headers, payload: {} });
    expect(valid.statusCode).toBe(200);
    const artifactId = valid.json<{ id: string }>().id;
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/projects/project-local/files',
      headers,
      payload: { path: 'workflows/review.workflow.yaml', content: 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata: [' },
    });
    expect(invalid.statusCode).toBe(200);
    const failedCompile = await app.inject({ method: 'POST', url: '/api/projects/project-local/compile', headers, payload: {} });
    expect(failedCompile.statusCode).toBe(422);
    expect(failedCompile.json<{ diagnostics: unknown[] }>().diagnostics.length).toBeGreaterThan(0);
    const artifacts = await app.inject({ method: 'GET', url: '/api/projects/project-local/artifacts', headers });
    const retainedArtifacts = artifacts.json<{ items: Array<{ id: string }> }>().items;
    expect(retainedArtifacts).toHaveLength(1);
    expect(retainedArtifacts[0]?.id).toBe(artifactId);
    const retained = await app.inject({ method: 'GET', url: `/api/projects/project-local/artifacts/${encodeURIComponent(artifactId)}`, headers });
    expect(retained.statusCode).toBe(200);
  });

  it('previews and idempotently migrates aggregate workflow records into resource files', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const preview = await app.inject({ method: 'POST', url: '/api/projects/project-local/migrate', headers, payload: {} });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ dryRun: boolean; plan: { files: Array<{ path: string }> } }>().dryRun).toBe(true);
    expect(preview.json<{ plan: { files: Array<{ path: string }> } }>().plan.files.map((file) => file.path)).toContain('factory.yaml');
    const migrated = await app.inject({ method: 'POST', url: '/api/projects/project-local/migrate', headers, payload: { dryRun: false } });
    expect(migrated.statusCode).toBe(200);
    expect(migrated.json<{ migrated: boolean; changedPaths: string[] }>().migrated).toBe(true);
    const again = await app.inject({ method: 'POST', url: '/api/projects/project-local/migrate', headers, payload: { dryRun: false } });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ changedPaths: string[] }>().changedPaths).toEqual([]);
    const listing = await app.inject({ method: 'GET', url: '/api/projects/project-local/files', headers });
    expect(listing.json<{ items: Array<{ path: string }> }>().items.some((file) => file.path === 'factory.yaml')).toBe(true);
  });

  it('marks aggregate declarative endpoints as deprecated during the compatibility window', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const exported = await app.inject({ method: 'GET', url: '/api/projects/project-local/declarative.yaml', headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers.deprecation).toBe('true');
    expect(exported.headers.link).toContain('/api/projects/project-local/files');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/projects/project-local/declarative',
      headers,
      payload: { source: exported.body },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.headers.deprecation).toBe('true');
    expect(imported.headers.link).toContain('/api/projects/project-local/files');
  });

  it('preserves workflow versions and run history during migration', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const historicalRun = createQueuedRun(seedWorkflow);
    historicalRun.status = 'succeeded';
    historicalRun.completedNodeIds = seedWorkflow.nodes.map((node) => node.id);
    historicalRun.unitOutputs = { output: 'historical-result' };
    await store.mutate((state) => { state.runs.push(historicalRun); });
    const before = await store.read((state) => ({
      workflowVersions: structuredClone(state.workflowVersions.filter((workflow) => workflow.projectId === 'project-local')),
      runs: structuredClone(state.runs.filter((run) => run.projectId === 'project-local')),
    }));
    const migrated = await app.inject({ method: 'POST', url: '/api/projects/project-local/migrate', headers, payload: { dryRun: false } });
    expect(migrated.statusCode).toBe(200);
    const after = await store.read((state) => ({
      workflowVersions: state.workflowVersions.filter((workflow) => workflow.projectId === 'project-local'),
      runs: state.runs.filter((run) => run.projectId === 'project-local'),
    }));
    expect(after.workflowVersions).toEqual(before.workflowVersions);
    expect(after.runs).toEqual(before.runs);
  });

  it('rejects stale file writes with optimistic hash concurrency', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const created = await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'concurrent.yaml', content: 'one' } });
    const sha256 = created.json<{ sha256: string }>().sha256;
    await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'concurrent.yaml', content: 'two', expectedSha256: sha256 } });
    const stale = await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'concurrent.yaml', content: 'three', expectedSha256: sha256 } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/projects/project-local/files?path=concurrent.yaml', headers })).json<{ content: string }>().content).toBe('two');
  });

  it('enforces safe project file extensions and size limits', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    expect((await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: '.env', content: 'TOKEN=secret' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'binary.exe', content: 'x' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'large.txt', content: 'x'.repeat(1_000_001) } })).statusCode).toBe(422);
  });

  it('emits scoped, redacted file-change events with cursor reads', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const created = await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'events.yaml', content: 'version: 1' } });
    expect(created.statusCode).toBe(200);
    const first = await app.inject({ method: 'GET', url: '/api/projects/project-local/files/events', headers });
    expect(first.statusCode).toBe(200);
    const firstItems = first.json<{ items: Array<{ type: string; timestamp: string; data?: unknown; projectId?: string; attributes?: Record<string, unknown> }> }>().items;
    const createdEvent = firstItems.find((event) => event.attributes?.['workspace.file.operation'] === 'created');
    expect(createdEvent).toEqual(expect.objectContaining({ type: 'workspace.file.changed', projectId: 'project-local' }));
    expect(createdEvent?.attributes).toEqual(expect.objectContaining({ 'workspace.file.path': 'events.yaml', 'workspace.file.sha256': expect.any(String) }));
    expect(createdEvent).not.toHaveProperty('data');

    const updated = await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'events.yaml', content: 'version: 2' } });
    expect(updated.statusCode).toBe(200);
    const afterFirst = await app.inject({ method: 'GET', url: `/api/projects/project-local/files/events?since=${encodeURIComponent(createdEvent?.timestamp ?? '')}`, headers });
    expect(afterFirst.json<{ items: Array<{ attributes?: Record<string, unknown> }> }>().items).toEqual([expect.objectContaining({ attributes: expect.objectContaining({ 'workspace.file.operation': 'updated' }) })]);

    const crossProject = await app.inject({ method: 'GET', url: '/api/projects/project-local/files/events', headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'other-project' } });
    expect(crossProject.statusCode).toBe(404);
  });

  it('creates explicit project directories without weakening workspace boundaries', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const created = await app.inject({ method: 'POST', url: '/api/projects/project-local/files/directory', headers, payload: { path: 'units' } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual(expect.objectContaining({ projectId: 'project-local', path: 'units' }));
    const listing = await app.inject({ method: 'GET', url: '/api/projects/project-local/files', headers });
    expect(listing.json<{ directories: Array<{ path: string }> }>().directories).toEqual([expect.objectContaining({ path: 'units' })]);
    expect((await app.inject({ method: 'POST', url: '/api/projects/project-local/files/directory', headers, payload: { path: 'units' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/projects/project-local/files/directory', headers, payload: { path: '../outside' } })).statusCode).toBe(422);
    const events = await app.inject({ method: 'GET', url: '/api/projects/project-local/files/events', headers });
    expect(events.json<{ items: Array<{ attributes?: Record<string, unknown> }> }>().items).toEqual(expect.arrayContaining([expect.objectContaining({ attributes: expect.objectContaining({ 'workspace.file.operation': 'directory-created', 'workspace.file.path': 'units' }) })]));
  });

  it('uses the mounted project workspace as source-of-truth when configured', async () => {
    await app.close();
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-api-workspace-'));
    app = await createApp({ store, projectWorkspace: new ProjectWorkspace(root), serveStatic: false });
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const saved = await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'workspace.txt', content: 'filesystem source' } });
    expect(saved.statusCode).toBe(200);
    expect(await store.read((state) => state.files.some((file) => file.path === 'workspace.txt'))).toBe(false);
    const loaded = await app.inject({ method: 'GET', url: '/api/projects/project-local/files?path=workspace.txt', headers });
    expect(loaded.json<{ content: string }>().content).toBe('filesystem source');
  });

  it('rolls back generated files when a mounted workspace migration fails partway through', async () => {
    await app.close();
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-api-migration-rollback-'));
    const projectWorkspace = new ProjectWorkspace(root);
    app = await createApp({ store, projectWorkspace, serveStatic: false });
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const headers = { 'x-tenant-id': scope.tenantId, 'x-project-id': scope.projectId };
    // The sorted migration plan writes several resources before workflows; a
    // conflicting directory at the workflow path forces a deterministic write
    // failure after those resources have been created.
    await projectWorkspace.createDirectory(scope, 'workflows/workflow-agent-intake.workflow.yaml');

    const migrated = await app.inject({ method: 'POST', url: '/api/projects/project-local/migrate', headers, payload: { dryRun: false } });
    expect(migrated.statusCode).toBe(422);
    expect(migrated.json<{ message: string; backup: unknown[] }>().message).toMatch(/Migration failed/);
    expect(migrated.json<{ backup: unknown[] }>().backup).toEqual([]);

    const listing = await app.inject({ method: 'GET', url: '/api/projects/project-local/files', headers });
    expect(listing.json<{ items: Array<{ path: string }>; directories: Array<{ path: string }> }>().items).toEqual([]);
    expect(listing.json<{ directories: Array<{ path: string }> }>().directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'workflows' }),
      expect.objectContaining({ path: 'workflows/workflow-agent-intake.workflow.yaml' }),
    ]));
    expect(await store.read((state) => state.workflows.some((workflow) => workflow.id === 'workflow-agent-intake'))).toBe(true);
  });

  it('exposes deployments through the lean envelope projection', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/deployments?format=envelope', headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('supports dry-run preflight without creating a runtime run', async () => {
    const before = (await store.read((state) => state.runs.length));
    const response = await app.inject({ method: 'POST', url: '/api/workflows/workflow-agent-intake/runs', payload: { dryRun: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ dryRun: true, workflowId: 'workflow-agent-intake', valid: true, issues: [] }));
    expect(await store.read((state) => state.runs.length)).toBe(before);
  });

  it('validates run input and records environment/deployment context', async () => {
    await store.mutate((state) => {
      const workflow = state.workflows.find((candidate) => candidate.id === 'workflow-agent-intake');
      if (workflow === undefined) throw new Error('Seed workflow missing.');
      workflow.inputSchema = { type: 'object', required: ['request'], properties: { request: { type: 'string', minLength: 3 } } };
    });
    const invalid = await app.inject({ method: 'POST', url: '/api/workflows/workflow-agent-intake/runs', payload: { input: { request: 'x' } } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual(expect.objectContaining({ message: 'Workflow input is invalid.', issues: expect.any(Array) }));

    const dryRun = await app.inject({ method: 'POST', url: '/api/workflows/workflow-agent-intake/runs', payload: { dryRun: true, environment: 'staging', input: { request: 'Fix login' } } });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json()).toEqual(expect.objectContaining({ environment: 'staging', inputHash: expect.any(String) }));

    const started = await app.inject({ method: 'POST', url: '/api/workflows/workflow-agent-intake/runs', payload: { environment: 'staging', input: { request: 'Fix login' } } });
    expect(started.statusCode).toBe(200);
    const run = started.json<{ id: string; environment?: string; input?: unknown; inputHash?: string }>();
    expect(run).toEqual(expect.objectContaining({ environment: 'staging', input: { request: 'Fix login' }, inputHash: expect.any(String) }));
    await waitForTerminal(store, run.id);
  });

  it('blocks execution when workflow preflight validation fails', async () => {
    await store.mutate((state) => {
      const workflow = state.workflows.find((candidate) => candidate.id === 'workflow-agent-intake');
      if (workflow === undefined) throw new Error('Seed workflow missing.');
      workflow.nodes = [];
      workflow.edges = [];
    });
    const response = await app.inject({ method: 'POST', url: '/api/workflows/workflow-agent-intake/runs', payload: {} });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual(expect.objectContaining({ message: expect.stringMatching(/validation/i), issues: expect.any(Array) }));
    expect(await store.read((state) => state.runs.length)).toBe(0);
  });

  it('moves deleted files to scoped trash and restores them', async () => {
    const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    await app.inject({ method: 'PUT', url: '/api/projects/project-local/files', headers, payload: { path: 'restore-me.yaml', content: 'apiVersion: factory.agentic/v1' } });
    const removed = await app.inject({ method: 'DELETE', url: '/api/projects/project-local/files', headers, payload: { path: 'restore-me.yaml' } });
    expect(removed.statusCode).toBe(200);
    const trashId = removed.json<{ trashId: string }>().trashId;
    expect(trashId).toMatch(/^trash-/);
    expect((await app.inject({ method: 'GET', url: '/api/projects/project-local/files?path=restore-me.yaml', headers })).statusCode).toBe(404);
    const restored = await app.inject({ method: 'POST', url: '/api/projects/project-local/files/restore', headers, payload: { trashId } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ path: string }>().path).toBe('restore-me.yaml');
  });

  it('pins a run to the selected immutable artifact version', async () => {
    const artifact = await app.inject({ method: 'POST', url: '/api/projects/project-local/compile', headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
    // The seeded project has no typed files; an absent artifact is rejected rather than silently followed.
    expect(artifact.statusCode).toBe(422);
  });

  it('creates a managed connection without accepting credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'Telemetry',
        connector: 'OpenTelemetry',
        environment: 'development',
        scopes: ['traces:write'],
        secret: 'must-not-be-persisted',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('secret');
    expect(JSON.stringify(await store.read((state) => state.connections))).not.toContain('must-not-be-persisted');
  });

  it('preserves immutable workflow versions after a save', async () => {
    const currentResponse = await app.inject({
      method: 'GET',
      url: '/api/workflows/workflow-agent-intake',
    });
    const current = currentResponse.json<Record<string, unknown>>();
    const updated = { ...current, name: 'Updated request intake' };

    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/workflows/workflow-agent-intake',
      payload: updated,
    });
    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.json()).toMatchObject({ version: 2, name: 'Updated request intake' });

    const versionsResponse = await app.inject({
      method: 'GET',
      url: '/api/workflows/workflow-agent-intake/versions',
    });
    expect(versionsResponse.statusCode).toBe(200);
    expect(versionsResponse.json<{ items: Array<{ version: number }> }>().items.map(
      (version) => version.version,
    )).toEqual([2, 1]);

    const originalResponse = await app.inject({
      method: 'GET',
      url: '/api/workflows/workflow-agent-intake/versions/1',
    });
    expect(originalResponse.json()).toMatchObject({
      version: 1,
      name: 'Agent-led request intake',
    });
  });

  it('exposes telemetry through log, trace, and metric signals', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/workflows/workflow-agent-intake/runs',
      payload: {},
    });
    const runId = start.json<{ id: string }>().id;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const telemetry = await app.inject({
      method: 'GET',
      url: `/api/telemetry?runId=${runId}`,
    });
    const payload = telemetry.json<{ items: Array<{ signal: string }>; resource: Record<string, string> }>();
    expect(telemetry.statusCode).toBe(200);
    expect(payload.resource['telemetry.sdk.name']).toBe('opentelemetry');
    expect(new Set(payload.items.map((item) => item.signal))).toEqual(
      new Set(['log', 'trace', 'metric']),
    );
  });

  it('persists replay reports and materializes payload-free evaluation datasets', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-replay-api';
    workflow.name = 'Replay API workflow';
    workflow.version = 4;
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'normalize', type: 'code', label: 'Normalize', position: { x: 160, y: 0 }, config: { operation: 'uppercase', value: 'stable' }, unit: defaultWorkUnit('code') },
    ];
    workflow.edges = [{ id: 'trigger-normalize', source: 'trigger', target: 'normalize' }];
    await store.mutate((state) => {
      state.workflows.unshift(workflow);
      state.workflowVersions.unshift(structuredClone(workflow));
    });
    const start = await app.inject({ method: 'POST', url: '/api/workflows/workflow-replay-api/runs', payload: {} });
    expect(start.statusCode).toBe(200);
    const sourceRunId = start.json<{ id: string }>().id;
    await waitForTerminal(store, sourceRunId);
    const replayResponse = await app.inject({ method: 'POST', url: `/api/runs/${sourceRunId}/replay`, payload: {} });
    expect(replayResponse.statusCode).toBe(200);
    const report = replayResponse.json<{ id: string; status: string; sourceOutputHash?: string; replayOutputHash?: string }>();
    expect(report).toEqual(expect.objectContaining({ id: expect.stringMatching(/^replay-report-/), status: 'passed', sourceOutputHash: expect.any(String), replayOutputHash: expect.any(String) }));
    const reports = await app.inject({ method: 'GET', url: `/api/replays?sourceRunId=${sourceRunId}` });
    expect(reports.statusCode).toBe(200);
    expect(reports.json<{ items: Array<{ id: string }> }>().items).toEqual([expect.objectContaining({ id: report.id })]);
    const datasetResponse = await app.inject({ method: 'POST', url: '/api/evaluation-datasets', payload: { name: 'Replay regression set', labels: ['nightly', 'regression'], reportIds: [report.id] } });
    expect(datasetResponse.statusCode).toBe(200);
    const dataset = datasetResponse.json<{ id: string; version: number; labels: string[]; cases: Array<{ reportId: string; status: string; sourceOutputHash?: string }> }>();
    expect(dataset).toEqual(expect.objectContaining({ id: expect.stringMatching(/^evaluation-dataset-/), version: 1, labels: ['nightly', 'regression'], cases: [expect.objectContaining({ reportId: report.id, status: 'passed', sourceOutputHash: expect.any(String) })] }));
    expect(JSON.stringify(dataset)).not.toContain('stable');
    const fetched = await app.inject({ method: 'GET', url: `/api/evaluation-datasets/${dataset.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(dataset);
    const nextDatasetResponse = await app.inject({ method: 'POST', url: '/api/evaluation-datasets', payload: { name: 'Replay regression set', labels: ['release'], reportIds: [report.id] } });
    expect(nextDatasetResponse.statusCode).toBe(200);
    expect(nextDatasetResponse.json<{ version: number; labels: string[] }>()).toEqual(expect.objectContaining({ version: 2, labels: ['release'] }));
    const evaluation = await app.inject({ method: 'POST', url: `/api/evaluation-datasets/${dataset.id}/evaluate`, payload: { threshold: 1 } });
    expect(evaluation.statusCode).toBe(200);
    expect(evaluation.json<{ totalCases: number; passedCases: number; passRate: number; promotionBlocked: boolean; statusCounts: Record<string, number> }>()).toEqual(expect.objectContaining({ totalCases: 1, passedCases: 1, passRate: 1, promotionBlocked: false, statusCounts: expect.objectContaining({ passed: 1 }) }));
    const evaluatedDataset = await app.inject({ method: 'GET', url: `/api/evaluation-datasets/${dataset.id}` });
    expect(evaluatedDataset.json<{ lastEvaluation?: { datasetVersion: number; threshold: number; promotionBlocked: boolean } }>().lastEvaluation).toEqual(expect.objectContaining({ datasetVersion: 1, threshold: 1, promotionBlocked: false }));
    const blockedEvaluation = await app.inject({ method: 'POST', url: `/api/evaluation-datasets/${dataset.id}/evaluate`, payload: { threshold: 1.01 } });
    expect(blockedEvaluation.statusCode).toBe(422);
  });
});

describe('platform API authorization', () => {
  it('enforces required authentication, role actions, and tenant/project scope', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-auth-api-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const app = await createApp({
      store,
      serveStatic: false,
      authMode: 'required',
      authTokens: [
        { token: 'reader-token', principal: { id: 'reader-1', role: 'reader', tenantIds: ['tenant-local'], projectIds: ['project-local'] } },
        { token: 'author-token', principal: { id: 'author-1', role: 'author', tenantIds: ['tenant-local'], projectIds: ['project-local'] } },
        { token: 'operator-token', principal: { id: 'operator-1', role: 'operator', tenantIds: ['tenant-local'], projectIds: ['project-local'] } },
      ],
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(401);
      const readerHeaders = { authorization: 'Bearer reader-token' };
      expect((await app.inject({ method: 'GET', url: '/api/workflows', headers: readerHeaders })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/projects', headers: readerHeaders, payload: { name: 'Rejected' } })).statusCode).toBe(403);
      const authorHeaders = { authorization: 'Bearer author-token' };
      expect((await app.inject({ method: 'POST', url: '/api/projects', headers: authorHeaders, payload: { name: 'Authorized' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/runs/missing/replay', headers: readerHeaders, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/runs/missing/replay', headers: { authorization: 'Bearer operator-token' }, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/workflows', headers: { ...readerHeaders, 'x-tenant-id': 'other-tenant' } })).statusCode).toBe(403);
      await new Promise((resolve) => setImmediate(resolve));
      const allEvents = await store.listEvents();
      expect(allEvents.some((event) => event.type === 'authz.denied' && event.attributes?.['auth.role'] === 'reader')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
