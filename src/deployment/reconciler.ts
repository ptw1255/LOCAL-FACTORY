import { randomUUID } from 'node:crypto';

import type { ArtifactRecord, DeploymentAction, DeploymentRecord, DeploymentTransition } from '../domain/types.js';
import type { PlatformStore } from '../storage/store.js';

export interface DeploymentScope { tenantId: string; projectId: string }

export interface DeploymentObservation {
  observedState: DeploymentRecord['observedState'];
  health: DeploymentRecord['health'];
  triggerStatus: DeploymentRecord['triggerStatus'];
  lastError?: string;
}

export interface DeploymentRuntimeAdapter {
  observe(deployment: DeploymentRecord): Promise<DeploymentObservation> | DeploymentObservation;
}

const localRuntimeAdapter: DeploymentRuntimeAdapter = {
  observe: (deployment) => ({
    observedState: deployment.desiredState === 'running' ? 'live' : 'stopped',
    health: deployment.desiredState === 'running' ? 'healthy' : 'unknown',
    triggerStatus: deployment.desiredState === 'running' ? 'active' : 'inactive',
  }),
};

/** Logical deployment reconciler for the local runtime adapter. */
export class DeploymentReconciler {
  private readonly ownerId = `reconciler-${randomUUID()}`;

  public constructor(private readonly store: PlatformStore, private readonly leaseMs = 30_000, private readonly adapter: DeploymentRuntimeAdapter = localRuntimeAdapter, private readonly maxObserveAttempts = 3) {}

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
        healthyArtifactIds: [],
        history: [],
      };
      state.deployments.unshift(deployment);
      return deployment;
    });
  }

  public async action(id: string, scope: DeploymentScope, action: DeploymentAction, options: { artifactId?: string; actor?: string; reason?: string } = {}): Promise<DeploymentRecord> {
    let transitionError: unknown;
    const result = await this.store.mutate(async (state) => {
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
          if (action === 'rollback' && (!deployment.healthyArtifactIds.includes(targetArtifactId) || targetArtifactId === deployment.artifactId)) throw new Error('Rollback requires a prior healthy artifact for this deployment.');
          deployment.artifactId = targetArtifactId;
        }
        if (action === 'stop') { deployment.desiredState = 'stopped'; deployment.observedState = 'stopping'; }
        else { deployment.desiredState = 'running'; deployment.observedState = 'starting'; }
        deployment.lastError = undefined;
        const observation = await this.observeWithRetry(deployment);
        deployment.observedState = observation.observedState;
        deployment.health = observation.health;
        deployment.triggerStatus = observation.triggerStatus;
        deployment.lastError = observation.lastError;
        if (deployment.observedState === 'live' && deployment.health === 'healthy' && !deployment.healthyArtifactIds.includes(deployment.artifactId)) deployment.healthyArtifactIds.unshift(deployment.artifactId);
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
    let transitionError: unknown;
    const result = await this.store.mutate(async (state) => {
      const deployment = state.deployments.find((candidate) => candidate.id === id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
      if (deployment === undefined) throw new Error('Deployment not found.');
      const now = new Date();
      this.acquireLease(deployment, now.toISOString());
      try {
        if (this.findArtifact(state.artifacts, deployment.artifactId, scope) === undefined) {
          throw new Error('Deployment artifact is no longer available for this project.');
        }
        const previousObserved = deployment.observedState;
        const observation = await this.observeWithRetry(deployment);
        const targetObserved = observation.observedState;
        if (previousObserved !== targetObserved) {
          deployment.observedState = targetObserved;
          deployment.health = observation.health;
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
        deployment.health = observation.health;
        deployment.triggerStatus = observation.triggerStatus;
        deployment.lastError = observation.lastError;
        if (deployment.observedState === 'live' && deployment.health === 'healthy' && !deployment.healthyArtifactIds.includes(deployment.artifactId)) deployment.healthyArtifactIds.unshift(deployment.artifactId);
        deployment.updatedAt = now.toISOString();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Deployment reconciliation failed.';
        deployment.observedState = 'failed';
        deployment.health = 'degraded';
        deployment.lastError = message;
        deployment.updatedAt = now.toISOString();
        const last = deployment.history[0];
        if (last?.outcome !== 'failed' || last.reason !== message) {
          deployment.history.unshift({
            id: randomUUID(),
            action: deployment.desiredState === 'running' ? 'start' : 'stop',
            actor: 'reconciler',
            occurredAt: now.toISOString(),
            fromArtifactId: deployment.artifactId,
            toArtifactId: deployment.artifactId,
            outcome: 'failed',
            reason: message,
          });
        }
        transitionError = error;
      } finally {
        delete deployment.lease;
      }
      return deployment;
    });
    if (transitionError !== undefined) throw transitionError;
    return result;
  }

  private acquireLease(deployment: DeploymentRecord, nowIso: string): void {
    const now = Date.parse(nowIso);
    const activeLease = deployment.lease;
    if (activeLease !== undefined && activeLease.ownerId !== this.ownerId && Date.parse(activeLease.expiresAt) > now) {
      throw new Error(`Deployment is currently reconciled by ${activeLease.ownerId}.`);
    }
    deployment.lease = { ownerId: this.ownerId, expiresAt: new Date(now + Math.max(1_000, this.leaseMs)).toISOString() };
  }

  private async observeWithRetry(deployment: DeploymentRecord): Promise<DeploymentObservation> {
    const attempts = Math.max(1, Math.min(10, Math.floor(this.maxObserveAttempts)));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.adapter.observe(deployment);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) break;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, 25 * attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Deployment runtime observation failed.');
  }

  private findArtifact(artifacts: ArtifactRecord[], id: string, scope: DeploymentScope): ArtifactRecord | undefined {
    return artifacts.find((artifact) => artifact.id === id && artifact.tenantId === scope.tenantId && artifact.projectId === scope.projectId);
  }
}
