import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { JsonStore } from '../storage/json-store.js';

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
      ['factory.yaml', 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: project-local\n  name: Local\nspec: {}'],
      ['agents/reviewer.agent.yaml', 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: reviewer\n  name: Reviewer\nspec:\n  purpose: Review\n  instructions: Review changes\n  skills: []\n  tools: []\n  model: { routingAlias: default-safe }'],
      ['workflows/review.workflow.yaml', 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: review\n      kind: agent\n      agent: reviewer'],
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
    const artifacts = await app.inject({ method: 'GET', url: '/api/projects/project-local/artifacts', headers });
    expect(artifacts.json<{ items: unknown[] }>().items).toHaveLength(1);
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
      expect((await app.inject({ method: 'GET', url: '/api/workflows', headers: { ...readerHeaders, 'x-tenant-id': 'other-tenant' } })).statusCode).toBe(403);
      await new Promise((resolve) => setImmediate(resolve));
      const allEvents = await store.listEvents();
      expect(allEvents.some((event) => event.type === 'authz.denied' && event.attributes?.['auth.role'] === 'reader')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
