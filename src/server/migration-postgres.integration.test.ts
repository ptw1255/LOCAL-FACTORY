import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { createQueuedRun } from '../runtime/executor.js';
import { PostgresStore } from '../storage/postgres-store.js';
import { createApp } from './app.js';

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(integrationDatabaseUrl === undefined)('PostgreSQL migration integration', () => {
  it('migrates an aggregate project idempotently without losing history', async () => {
    const tenantId = `migration-tenant-${randomUUID()}`;
    const projectId = `migration-project-${randomUUID()}`;
    const workflow = structuredClone(seedWorkflow);
    workflow.id = `migration-workflow-${randomUUID()}`;
    workflow.tenantId = tenantId;
    workflow.projectId = projectId;
    workflow.name = 'PostgreSQL migration fixture';
    const historicalRun = createQueuedRun(workflow);
    historicalRun.status = 'succeeded';
    historicalRun.completedNodeIds = workflow.nodes.map((node) => node.id);
    historicalRun.unitOutputs = { output: 'migration-history-preserved' };
    const store = new PostgresStore(integrationDatabaseUrl!);
    await store.mutate((state) => {
      state.tenants.push({ id: tenantId, name: 'Migration integration tenant', createdAt: new Date().toISOString() });
      state.projects.push({ id: projectId, tenantId, name: 'Migration integration project', description: '', createdAt: new Date().toISOString() });
      state.workflows.push(workflow);
      state.workflowVersions.push(structuredClone(workflow));
      state.runs.push(historicalRun);
    });
    const app = await createApp({ store, serveStatic: false });
    const headers = { 'x-tenant-id': tenantId, 'x-project-id': projectId };
    try {
      const before = await store.read((state) => ({
        workflowVersions: structuredClone(state.workflowVersions.filter((candidate) => candidate.projectId === projectId)),
        runs: structuredClone(state.runs.filter((candidate) => candidate.projectId === projectId)),
      }));
      const preview = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/migrate`, headers, payload: {} });
      expect(preview.statusCode).toBe(200);
      expect(preview.json<{ dryRun: boolean; plan: { files: Array<{ path: string }> } }>().dryRun).toBe(true);
      expect(preview.json<{ plan: { files: Array<{ path: string }> } }>().plan.files.map((file) => file.path)).toContain('factory.yaml');

      const migrated = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/migrate`, headers, payload: { dryRun: false } });
      expect(migrated.statusCode).toBe(200);
      expect(migrated.json<{ migrated: boolean; changedPaths: string[] }>().migrated).toBe(true);
      const again = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/migrate`, headers, payload: { dryRun: false } });
      expect(again.statusCode).toBe(200);
      expect(again.json<{ changedPaths: string[] }>().changedPaths).toEqual([]);

      const after = await store.read((state) => ({
        files: state.files.filter((file) => file.projectId === projectId),
        workflowVersions: state.workflowVersions.filter((candidate) => candidate.projectId === projectId),
        runs: state.runs.filter((candidate) => candidate.projectId === projectId),
      }));
      expect(after.files.map((file) => file.path)).toContain('factory.yaml');
      expect(after.workflowVersions).toEqual(before.workflowVersions);
      expect(after.runs).toEqual(before.runs);
    } finally {
      await store.mutate((state) => {
        state.tenants = state.tenants.filter((tenant) => tenant.id !== tenantId);
        state.projects = state.projects.filter((project) => project.id !== projectId);
        state.workflows = state.workflows.filter((candidate) => candidate.projectId !== projectId);
        state.workflowVersions = state.workflowVersions.filter((candidate) => candidate.projectId !== projectId);
        state.runs = state.runs.filter((run) => run.projectId !== projectId);
        state.files = state.files.filter((file) => file.projectId !== projectId);
        state.directories = state.directories.filter((directory) => directory.projectId !== projectId);
        state.deletedFiles = state.deletedFiles.filter((file) => file.projectId !== projectId);
      });
      await app.close();
    }
  });
});
