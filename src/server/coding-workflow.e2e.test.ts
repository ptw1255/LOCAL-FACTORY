import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import { RepositoryWorkspace } from '../repository/workspace.js';
import { JsonStore } from '../storage/json-store.js';
import { createApp } from './app.js';

async function waitFor(app: Awaited<ReturnType<typeof createApp>>, runId: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const payload = app.inject({ method: 'GET', url: `/api/runs/${runId}` }).then((response) => response.json() as Record<string, unknown>);
    const current = await payload;
    if (current.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run did not reach ${status}.`);
}

describe('coding workflow API', () => {
  it('executes an isolated mutation, approval, evidence, and terminal path', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-repo-'));
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-coding-e2e';
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Prepare node is missing.');
    prepare.type = 'repositoryMutation';
    prepare.label = 'Apply approved change';
    prepare.config = { requiresApproval: true, operations: [{ operation: 'create', path: 'generated.txt', content: 'generated' }] };
    prepare.unit = defaultWorkUnit('repositoryMutation');
    await store.mutate((state) => {
      state.workflows.push(workflow);
      state.workflowVersions.push(structuredClone(workflow));
    });
    const app = await createApp({ store, repositoryWorkspace, serveStatic: false });
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
      expect(started.statusCode).toBe(200);
      const runId = (started.json() as { id: string }).id;
      expect((await waitFor(app, runId, 'waiting')).status).toBe('waiting');
      const waitingEvidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      expect((waitingEvidence.json() as { items: Array<{ status: string }> }).items.some((entry) => entry.status === 'waiting')).toBe(true);
      const approved = await app.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
      expect(approved.statusCode).toBe(200);
      expect((await waitFor(app, runId, 'succeeded')).status).toBe('succeeded');
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      expect((evidence.json() as { items: Array<{ unitId: string; status: string }> }).items.some((entry) => entry.unitId === 'prepare' && entry.status === 'succeeded')).toBe(true);
      await expect(readFile(path.join(repoRoot, 'generated.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
