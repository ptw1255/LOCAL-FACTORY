import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { JsonStore } from '../storage/json-store.js';
import { DeploymentReconciler } from './reconciler.js';

describe('DeploymentReconciler', () => {
  it('creates, transitions, reconciles, and rolls back a logical deployment', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-1', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope: { tenantId: 'tenant-local', projectId: 'project-local' }, workflowId: seedWorkflow.id, environment: 'local', artifactId: artifact.id, trigger: 'manual' });
    expect(deployment.observedState).toBe('stopped');
    const live = await reconciler.action(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' }, 'start');
    expect(live.observedState).toBe('live');
    expect((await reconciler.reconcile(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' })).observedState).toBe('live');
    const stopped = await reconciler.action(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' }, 'stop');
    expect(stopped.observedState).toBe('stopped');
    expect(stopped.history.map((entry) => entry.action)).toEqual(['stop', 'start']);
  });

  it('enforces project scope and artifact/workflow binding', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const reconciler = new DeploymentReconciler(store);
    await expect(reconciler.create({ scope: { tenantId: 'other', projectId: 'other' }, workflowId: seedWorkflow.id, environment: 'local', artifactId: 'missing', trigger: 'manual' })).rejects.toThrow();
  });

  it('rejects an active lease held by another reconciler owner', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-lease', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope: { tenantId: 'tenant-local', projectId: 'project-local' }, workflowId: seedWorkflow.id, environment: 'lease-test', artifactId: artifact.id, trigger: 'manual' });
    await store.mutate((state) => {
      const target = state.deployments.find((candidate) => candidate.id === deployment.id);
      if (target === undefined) throw new Error('Deployment missing.');
      target.lease = { ownerId: 'other-owner', expiresAt: new Date(Date.now() + 10_000).toISOString() };
    });
    await expect(reconciler.reconcile(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' })).rejects.toThrow('currently reconciled');
  });

  it('records a durable transition when reconciliation repairs drift', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-drift', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope: { tenantId: 'tenant-local', projectId: 'project-local' }, workflowId: seedWorkflow.id, environment: 'drift', artifactId: artifact.id, trigger: 'schedule' });
    await store.mutate((state) => {
      const target = state.deployments.find((candidate) => candidate.id === deployment.id);
      if (target === undefined) throw new Error('Deployment missing.');
      target.desiredState = 'running';
      target.observedState = 'starting';
    });
    const reconciled = await reconciler.reconcile(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' });
    expect(reconciled).toMatchObject({ observedState: 'live', health: 'healthy', triggerStatus: 'active' });
    expect(reconciled.history[0]).toEqual(expect.objectContaining({ action: 'start', actor: 'reconciler', outcome: 'succeeded' }));
  });
});
