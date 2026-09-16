import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import type { OperationEvidence, RunRecord } from '../domain/types.js';
import { EventService } from '../observability/event-service.js';
import { JsonStore } from '../storage/json-store.js';
import { DeploymentReconciler, type DeploymentRuntimeAdapter } from './reconciler.js';

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

  it('rejects stale operator actions before changing deployment state', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-stale-action', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'stale-action', artifactId: artifact.id, trigger: 'manual' });
    const started = await reconciler.action(deployment.id, scope, 'start');
    await expect(reconciler.action(deployment.id, scope, 'stop', { expectedUpdatedAt: deployment.updatedAt })).rejects.toThrow('changed since it was loaded');
    const current = (await reconciler.list(scope)).find((candidate) => candidate.id === deployment.id);
    expect(current).toMatchObject({ observedState: started.observedState, desiredState: started.desiredState });
    expect(current?.history).toHaveLength(1);
  });

  it('returns the original result for a retried idempotent action', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-idempotent', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'idempotent', artifactId: artifact.id, trigger: 'manual' });
    const first = await reconciler.action(deployment.id, scope, 'start', { idempotencyKey: 'operator-action-1' });
    const repeated = await reconciler.action(deployment.id, scope, 'start', { idempotencyKey: 'operator-action-1', expectedUpdatedAt: 'stale' });
    expect(repeated).toEqual(first);
    expect(repeated.history).toHaveLength(1);
    expect(repeated.history[0]?.idempotencyKey).toBe('operator-action-1');
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

  it('records rejected artifact transitions as failed history', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-reject', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope: { tenantId: 'tenant-local', projectId: 'project-local' }, workflowId: seedWorkflow.id, environment: 'reject', artifactId: artifact.id, trigger: 'manual' });
    await expect(reconciler.action(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' }, 'rollback', { artifactId: 'missing-artifact', actor: 'test-operator', reason: 'Artifact was not promoted.' })).rejects.toThrow('not available');
    const rejected = await reconciler.list({ tenantId: 'tenant-local', projectId: 'project-local' });
    expect(rejected[0]?.history[0]).toEqual(expect.objectContaining({ action: 'rollback', actor: 'test-operator', outcome: 'failed', reason: 'Deployment artifact is not available for this workflow.' }));
    expect(rejected[0]?.artifactId).toBe(artifact.id);
  });

  it('surfaces degraded health from the runtime adapter during reconciliation', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-health', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const adapter: DeploymentRuntimeAdapter = {
      observe: (deployment) => deployment.desiredState === 'running'
        ? { observedState: 'degraded', health: 'degraded', triggerStatus: 'active', lastError: 'Health probe failed.' }
        : { observedState: 'stopped', health: 'unknown', triggerStatus: 'inactive' },
    };
    const reconciler = new DeploymentReconciler(store, 30_000, adapter);
    const deployment = await reconciler.create({ scope: { tenantId: 'tenant-local', projectId: 'project-local' }, workflowId: seedWorkflow.id, environment: 'health', artifactId: artifact.id, trigger: 'manual' });
    const started = await reconciler.action(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' }, 'start');
    expect(started).toMatchObject({ observedState: 'degraded', health: 'degraded', triggerStatus: 'active', lastError: 'Health probe failed.' });
    const reconciled = await reconciler.reconcile(deployment.id, { tenantId: 'tenant-local', projectId: 'project-local' });
    expect(reconciled).toMatchObject({ observedState: 'degraded', health: 'degraded', lastError: 'Health probe failed.' });
  });

  it('records reconciliation failures for stale artifacts and adapter errors', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-stale', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'stale', artifactId: artifact.id, trigger: 'manual' });
    await store.mutate((state) => { state.artifacts = state.artifacts.filter((candidate) => candidate.id !== artifact.id); });
    await expect(reconciler.reconcile(deployment.id, scope)).rejects.toThrow('no longer available');
    expect((await reconciler.list(scope))[0]).toEqual(expect.objectContaining({ observedState: 'failed', health: 'degraded', lastError: 'Deployment artifact is no longer available for this project.' }));

    const healthyArtifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-adapter-error', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const failing = new DeploymentReconciler(store, 30_000, { observe: () => { throw new Error('Runtime adapter unavailable.'); } });
    const second = await failing.create({ scope, workflowId: seedWorkflow.id, environment: 'adapter-error', artifactId: healthyArtifact.id, trigger: 'manual' });
    await expect(failing.reconcile(second.id, scope)).rejects.toThrow('Runtime adapter unavailable.');
    expect((await failing.list(scope)).find((candidate) => candidate.id === second.id)).toEqual(expect.objectContaining({ observedState: 'failed', health: 'degraded', lastError: 'Runtime adapter unavailable.' }));
  });

  it('recovers transient health adapter failures within the retry bound', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-retry', tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    let calls = 0;
    const reconciler = new DeploymentReconciler(store, 30_000, {
      observe: (deployment) => {
        calls += 1;
        if (calls < 3) throw new Error('Transient runtime unavailable.');
        return { observedState: deployment.desiredState === 'running' ? 'live' : 'stopped', health: deployment.desiredState === 'running' ? 'healthy' : 'unknown', triggerStatus: deployment.desiredState === 'running' ? 'active' : 'inactive' };
      },
    }, 3);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'retry', artifactId: artifact.id, trigger: 'manual' });
    const started = await reconciler.action(deployment.id, scope, 'start');
    expect(started).toMatchObject({ observedState: 'live', health: 'healthy' });
    expect(calls).toBe(3);
  });

  it('only rolls back to a previously observed healthy artifact', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const artifacts = await store.mutate((state) => {
      const values = ['one', 'two', 'never-healthy'].map((suffix) => ({ id: `sha256:artifact-${suffix}`, tenantId: 'tenant-local', projectId: 'project-local', environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() }));
      state.artifacts.push(...values);
      return values;
    });
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'rollback-health', artifactId: artifacts[0]!.id, trigger: 'manual' });
    await reconciler.action(deployment.id, scope, 'start');
    await reconciler.action(deployment.id, scope, 'deploy', { artifactId: artifacts[1]!.id });
    const rolledBack = await reconciler.action(deployment.id, scope, 'rollback', { artifactId: artifacts[0]!.id });
    expect(rolledBack.artifactId).toBe(artifacts[0]!.id);
    expect(rolledBack.healthyArtifactIds).toEqual(expect.arrayContaining([artifacts[0]!.id, artifacts[1]!.id]));
    await expect(reconciler.action(deployment.id, scope, 'rollback', { artifactId: artifacts[2]!.id })).rejects.toThrow('prior healthy artifact');
  });

  it('gates production promotion on a succeeded run with patch and CI evidence', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-production-gate', tenantId: scope.tenantId, projectId: scope.projectId, environment: 'production', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const run: RunRecord = {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      id: 'run-production-gate',
      workflowId: seedWorkflow.id,
      workflowName: seedWorkflow.name,
      workflowVersion: seedWorkflow.version,
      artifactId: artifact.id,
      traceId: 'a'.repeat(32),
      status: 'succeeded',
      startedAt: new Date().toISOString(),
      costUsd: 0,
      humanTouchpoints: 1,
      workflowDefinition: structuredClone(seedWorkflow),
      completedNodeIds: [],
      activatedNodeIds: [],
      approvedNodeIds: [],
      approvedNodeHashes: {},
      pendingApprovalHashes: {},
      unitOutputs: {},
      ciCheckpoints: {},
    };
    await store.mutate((state) => { state.runs.push(run); });
    const evidence = (operation: string, metadata?: Record<string, string | number | boolean>): OperationEvidence => ({
      id: `evidence-${operation}`,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      runId: run.id,
      unitId: operation,
      operation,
      attempt: 1,
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
      ...(metadata === undefined ? {} : { metadata }),
    });
    await store.appendEvidence(evidence('repositoryPatch'));
    await store.appendEvidence(evidence('repositoryCi', { 'ci.status': 'success' }));

    const reconciler = new DeploymentReconciler(store);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'production', artifactId: artifact.id, trigger: 'manual' });
    await expect(reconciler.action(deployment.id, scope, 'deploy', { artifactId: artifact.id })).rejects.toThrow('require a successful coding-workflow run');
    const promoted = await reconciler.action(deployment.id, scope, 'deploy', { artifactId: artifact.id, runId: run.id });
    expect(promoted).toMatchObject({ observedState: 'live', health: 'healthy', lastVerifiedRunId: run.id });
  });

  it('does not retain a verified run when protected promotion health fails', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-production-failure', tenantId: scope.tenantId, projectId: scope.projectId, environment: 'production', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const run: RunRecord = {
      tenantId: scope.tenantId, projectId: scope.projectId, id: 'run-production-failure', workflowId: seedWorkflow.id, workflowName: seedWorkflow.name, workflowVersion: seedWorkflow.version, artifactId: artifact.id, traceId: 'b'.repeat(32), status: 'succeeded', startedAt: new Date().toISOString(), costUsd: 0, humanTouchpoints: 1, workflowDefinition: structuredClone(seedWorkflow), completedNodeIds: [], activatedNodeIds: [], approvedNodeIds: [], approvedNodeHashes: {}, pendingApprovalHashes: {}, unitOutputs: {}, ciCheckpoints: {},
    };
    await store.mutate((state) => { state.runs.push(run); });
    await store.appendEvidence({ id: 'evidence-production-patch', tenantId: scope.tenantId, projectId: scope.projectId, runId: run.id, unitId: 'patch', operation: 'repositoryPatch', attempt: 1, status: 'succeeded', occurredAt: new Date().toISOString() });
    await store.appendEvidence({ id: 'evidence-production-ci', tenantId: scope.tenantId, projectId: scope.projectId, runId: run.id, unitId: 'ci', operation: 'repositoryCi', attempt: 1, status: 'succeeded', occurredAt: new Date().toISOString(), metadata: { 'ci.status': 'success' } });
    const reconciler = new DeploymentReconciler(store, 30_000, { observe: () => ({ observedState: 'degraded', health: 'degraded', triggerStatus: 'active', lastError: 'Health check failed.' }) });
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'production', artifactId: artifact.id, trigger: 'manual' });
    await expect(reconciler.action(deployment.id, scope, 'deploy', { artifactId: artifact.id, runId: run.id })).resolves.toMatchObject({ observedState: 'degraded', health: 'degraded' });
    expect((await reconciler.list(scope)).find((candidate) => candidate.id === deployment.id)?.lastVerifiedRunId).toBeUndefined();
  });

  it('correlates deployment transitions with durable evidence and telemetry', async () => {
    const store = new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'factory-deploy-')), 'state.json'));
    const scope = { tenantId: 'tenant-local', projectId: 'project-local' };
    const artifact = await store.mutate((state) => {
      const value = { id: 'sha256:artifact-evidence', tenantId: scope.tenantId, projectId: scope.projectId, environment: 'local', compilerVersion: '0.1.0', sources: [], workflows: [structuredClone(seedWorkflow)], createdAt: new Date().toISOString() };
      state.artifacts.push(value);
      return value;
    });
    const events = new EventService(store);
    const reconciler = new DeploymentReconciler(store, 30_000, undefined, 3, events);
    const deployment = await reconciler.create({ scope, workflowId: seedWorkflow.id, environment: 'evidence', artifactId: artifact.id, trigger: 'manual' });
    const started = await reconciler.action(deployment.id, scope, 'start', { actor: 'operator', runId: 'run-deployment-evidence', idempotencyKey: 'deployment-start-1' });
    const evidence = await events.listEvidence({ deploymentId: deployment.id });
    expect(evidence).toEqual([expect.objectContaining({ deploymentId: deployment.id, runId: 'run-deployment-evidence', operation: 'deployment.start', status: 'succeeded', idempotencyKey: 'deployment-start-1', tenantId: scope.tenantId, projectId: scope.projectId })]);
    const telemetry = await events.list('run-deployment-evidence');
    expect(telemetry).toEqual([expect.objectContaining({ type: 'deployment.transition', runId: 'run-deployment-evidence', signal: 'trace' })]);
    expect(started.history[0]).toEqual(expect.objectContaining({ runId: 'run-deployment-evidence', correlationId: expect.stringContaining(deployment.id) }));
  });
});
