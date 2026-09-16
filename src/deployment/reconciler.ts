import { randomUUID } from 'node:crypto';

import type { ArtifactRecord, DeploymentAction, DeploymentRecord, DeploymentTransition } from '../domain/types.js';
import type { PlatformStore } from '../storage/store.js';

export interface DeploymentScope { tenantId: string; projectId: string }

/** Logical deployment reconciler for the local runtime adapter. */
export class DeploymentReconciler {
  private readonly ownerId = `reconciler-${randomUUID()}`;

  public constructor(private readonly store: PlatformStore, private readonly leaseMs = 30_000) {}

  public list(scope: DeploymentScope): Promise<DeploymentRecord[]> {
    return this.store.read((state) => state.deployments.filter((deployment) => deployment.tenantId === scope.tenantId && deployment.projectId === scope.projectId));
  }

  public async create(input: { scope: DeploymentScope; workflowId: string; environment: string; artifactId: string; trigger: string; actor?: string }): Promise<DeploymentRecord> {
    return this.store.mutate((state) => {
      const artifact = this.findArtifact(state.artifacts, input.artifactId, input.scope);
      if (artifact === undefined || !artifact.workflows.some((workflow) => workflow.id === input.workflowId)) throw new Error('A deployment must reference an artifact containing the selected workflow.');
      const existing = state.deployments.find((candidate) => candidate.workflowId === input.workflowId && candidate.environment === input.environment && candidate.tenantId === input.scope.tenantId && candidate.projectId === input.scope.projectId);
      if (existing !== undefined) throw new Error('A deployment already exists for this workflow and environment.');
      const now = new Date().toISOString();
      const deployment: DeploymentRecord = {
        id: `deployment-${randomUUID()}`,
        tenantId: input.scope.tenantId,
        projectId: input.scope.projectId,
        workflowId: input.workflowId,
        environment: input.environment,
        artifactId: input.artifactId,
        desiredState: 'stopped',
        observedState: 'stopped',
        health: 'unknown',
        trigger: input.trigger,
        triggerStatus: 'inactive',
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      state.deployments.unshift(deployment);
      return deployment;
    });
  }

  public async action(id: string, scope: DeploymentScope, action: DeploymentAction, options: { artifactId?: string; actor?: string; reason?: string } = {}): Promise<DeploymentRecord> {
    let transitionError: unknown;
    const result = await this.store.mutate((state) => {
      const deployment = state.deployments.find((candidate) => candidate.id === id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
      if (deployment === undefined) throw new Error('Deployment not found.');
      const fromArtifactId = deployment.artifactId;
      const targetArtifactId = options.artifactId ?? deployment.artifactId;
      const actor = options.actor?.trim() || 'local-operator';
      const now = new Date().toISOString();
      this.acquireLease(deployment, now);
      try {
        if (action === 'deploy' || action === 'rollback') {
          const artifact = this.findArtifact(state.artifacts, targetArtifactId, scope);
          if (artifact === undefined || !artifact.workflows.some((workflow) => workflow.id === deployment.workflowId)) throw new Error('Deployment artifact is not available for this workflow.');
          deployment.artifactId = targetArtifactId;
        }
        if (action === 'stop') { deployment.desiredState = 'stopped'; deployment.observedState = 'stopping'; }
        else { deployment.desiredState = 'running'; deployment.observedState = 'starting'; }
        deployment.lastError = undefined;
        // The local adapter is synchronous once the artifact is validated. A future
        // container/cloud adapter can replace this section with an async reconcile loop.
        deployment.observedState = deployment.desiredState === 'running' ? 'live' : 'stopped';
        deployment.health = deployment.observedState === 'live' ? 'healthy' : 'unknown';
        deployment.triggerStatus = deployment.desiredState === 'running' ? 'active' : 'inactive';
        deployment.updatedAt = now;
        const transition: DeploymentTransition = {
          id: randomUUID(), action, actor, occurredAt: now,
          ...(fromArtifactId === undefined ? {} : { fromArtifactId }),
          ...(targetArtifactId === undefined ? {} : { toArtifactId: targetArtifactId }),
          outcome: 'succeeded',
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        };
        deployment.history.unshift(transition);
        return deployment;
      } catch (error) {
        deployment.observedState = 'failed';
        deployment.health = 'degraded';
        deployment.lastError = error instanceof Error ? error.message : 'Deployment transition failed.';
        deployment.updatedAt = now;
        deployment.history.unshift({ id: randomUUID(), action, actor, occurredAt: now, outcome: 'failed', reason: deployment.lastError });
        transitionError = error;
        return deployment;
      } finally {
        delete deployment.lease;
      }
    });
    if (transitionError !== undefined) throw transitionError;
    return result;
  }

  public async reconcile(id: string, scope: DeploymentScope): Promise<DeploymentRecord> {
    return this.store.mutate((state) => {
      const deployment = state.deployments.find((candidate) => candidate.id === id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
      if (deployment === undefined) throw new Error('Deployment not found.');
      const now = new Date();
      this.acquireLease(deployment, now.toISOString());
      try {
        const previousObserved = deployment.observedState;
        const targetObserved = deployment.desiredState === 'running' ? 'live' : 'stopped';
        if (previousObserved !== targetObserved) {
          deployment.observedState = targetObserved;
          deployment.health = targetObserved === 'live' ? 'healthy' : 'unknown';
          deployment.history.unshift({
            id: randomUUID(),
            action: targetObserved === 'live' ? 'start' : 'stop',
            actor: 'reconciler',
            occurredAt: now.toISOString(),
            fromArtifactId: deployment.artifactId,
            toArtifactId: deployment.artifactId,
            outcome: 'succeeded',
            reason: 'Desired state reconciled.',
          });
        }
        deployment.triggerStatus = deployment.desiredState === 'running' ? 'active' : 'inactive';
        deployment.updatedAt = now.toISOString();
      } finally {
        delete deployment.lease;
      }
      return deployment;
    });
  }

  private acquireLease(deployment: DeploymentRecord, nowIso: string): void {
    const now = Date.parse(nowIso);
    const activeLease = deployment.lease;
    if (activeLease !== undefined && activeLease.ownerId !== this.ownerId && Date.parse(activeLease.expiresAt) > now) {
      throw new Error(`Deployment is currently reconciled by ${activeLease.ownerId}.`);
    }
    deployment.lease = { ownerId: this.ownerId, expiresAt: new Date(now + Math.max(1_000, this.leaseMs)).toISOString() };
  }

  private findArtifact(artifacts: ArtifactRecord[], id: string, scope: DeploymentScope): ArtifactRecord | undefined {
    return artifacts.find((artifact) => artifact.id === id && artifact.tenantId === scope.tenantId && artifact.projectId === scope.projectId);
  }
}
