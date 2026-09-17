import { createHash, randomUUID } from 'node:crypto';

import type { ArtifactRecord, DeploymentAction, DeploymentApprovalDecision, DeploymentApprovalRecord, DeploymentRecord, DeploymentTransition, PlatformState } from '../domain/types.js';
import type { EventService } from '../observability/event-service.js';
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

function isProtectedEnvironment(environment: string): boolean {
  const normalized = environment.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod' || normalized === 'preprod' || normalized === 'staging';
}

function nextTimestamp(previous?: string): string {
  const now = Date.now();
  const previousMs = previous === undefined ? Number.NaN : Date.parse(previous);
  return new Date(Number.isFinite(previousMs) && now <= previousMs ? previousMs + 1 : now).toISOString();
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

  public constructor(private readonly store: PlatformStore, private readonly leaseMs = 30_000, private readonly adapter: DeploymentRuntimeAdapter = localRuntimeAdapter, private readonly maxObserveAttempts = 3, private readonly events?: EventService) {}

  public list(scope: DeploymentScope): Promise<DeploymentRecord[]> {
    return this.store.read((state) => state.deployments.filter((deployment) => deployment.tenantId === scope.tenantId && deployment.projectId === scope.projectId));
  }

  /** Reconcile every persisted deployment once for a control-plane poll. */
  public async reconcileAll(): Promise<{ reconciled: number; failed: number }> {
    const targets = await this.store.read((state) => state.deployments.map((deployment) => ({
      id: deployment.id,
      scope: { tenantId: deployment.tenantId, projectId: deployment.projectId },
    })));
    const results = await Promise.allSettled(targets.map((target) => this.reconcile(target.id, target.scope)));
    return {
      reconciled: results.filter((result) => result.status === 'fulfilled').length,
      failed: results.filter((result) => result.status === 'rejected').length,
    };
  }

  public async create(input: { scope: DeploymentScope; workflowId: string; environment: string; artifactId: string; trigger: string; actor?: string }): Promise<DeploymentRecord> {
    return this.store.mutate((state) => {
      const artifact = this.findArtifact(state.artifacts, input.artifactId, input.scope);
      if (artifact === undefined || !artifact.workflows.some((workflow) => workflow.id === input.workflowId)) throw new Error('A deployment must reference an artifact containing the selected workflow.');
      const existing = state.deployments.find((candidate) => candidate.workflowId === input.workflowId && candidate.environment === input.environment && candidate.tenantId === input.scope.tenantId && candidate.projectId === input.scope.projectId);
      if (existing !== undefined) throw new Error('A deployment already exists for this workflow and environment.');
      const now = nextTimestamp();
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

  public async requestApproval(id: string, scope: DeploymentScope, input: { artifactId: string; runId: string; actor?: string; expiresInMs?: number }): Promise<DeploymentApprovalRecord> {
    return this.store.mutate((state) => {
      const deployment = state.deployments.find((candidate) => candidate.id === id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
      if (deployment === undefined) throw new Error('Deployment not found.');
      if (!isProtectedEnvironment(deployment.environment)) throw new Error('Deployment approval is only required for protected environments.');
      const artifact = this.findArtifact(state.artifacts, input.artifactId, scope);
      if (artifact === undefined || !artifact.workflows.some((workflow) => workflow.id === deployment.workflowId)) throw new Error('Deployment artifact is not available for this workflow.');
      this.requireSuccessfulPromotionEvidence(state, deployment, scope, input.runId, input.artifactId);
      const existing = state.deploymentApprovals.find((approval) => approval.deploymentId === id && approval.artifactId === input.artifactId && approval.runId === input.runId && approval.decision === 'pending');
      if (existing !== undefined) return existing;
      const requestedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + Math.max(60_000, Math.min(input.expiresInMs ?? 30 * 60_000, 24 * 60 * 60_000))).toISOString();
      const approval: DeploymentApprovalRecord = {
        id: `deployment-approval-${randomUUID()}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        deploymentId: id,
        artifactId: input.artifactId,
        runId: input.runId,
        bindingHash: deploymentApprovalBindingHash(id, input.artifactId, input.runId),
        decision: 'pending',
        requestedAt,
        expiresAt,
        ...(input.actor?.trim() === undefined ? {} : { actor: input.actor.trim() }),
      };
      state.deploymentApprovals.unshift(approval);
      return approval;
    });
  }

  public async decideApproval(id: string, scope: DeploymentScope, approvalId: string, decision: Exclude<DeploymentApprovalDecision, 'pending' | 'expired'>, options: { actor?: string; reason?: string } = {}): Promise<DeploymentApprovalRecord> {
    return this.store.mutate((state) => {
      const approval = state.deploymentApprovals.find((candidate) => candidate.id === approvalId && candidate.deploymentId === id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
      if (approval === undefined) throw new Error('Deployment approval not found.');
      if (approval.decision !== 'pending') throw new Error('Deployment approval is no longer pending.');
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        approval.decision = 'expired';
        approval.decidedAt = new Date().toISOString();
        throw new Error('Deployment approval expired.');
      }
      approval.decision = decision;
      approval.actor = options.actor?.trim() || 'local-operator';
      approval.reason = options.reason?.trim();
      approval.decidedAt = new Date().toISOString();
      return approval;
    });
  }

  public async action(id: string, scope: DeploymentScope, action: DeploymentAction, options: { artifactId?: string; actor?: string; reason?: string; expectedUpdatedAt?: string; idempotencyKey?: string; runId?: string; approvalId?: string } = {}): Promise<DeploymentRecord> {
    let transitionError: unknown;
    let applied = false;
    const result = await this.store.mutate(async (state) => {
      const deployment = state.deployments.find((candidate) => candidate.id === id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
      if (deployment === undefined) throw new Error('Deployment not found.');
      if (options.idempotencyKey !== undefined) {
        const prior = deployment.history.find((transition) => transition.idempotencyKey === options.idempotencyKey);
        if (prior !== undefined) return deployment;
      }
      if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== deployment.updatedAt) {
        throw new Error('Deployment changed since it was loaded; refresh before retrying the action.');
      }
      const fromArtifactId = deployment.artifactId;
      const targetArtifactId = options.artifactId ?? deployment.artifactId;
      const actor = options.actor?.trim() || 'local-operator';
      // Updated-at is an optimistic concurrency token; ensure two transitions
      // in the same millisecond still produce distinct versions.
      const now = nextTimestamp(deployment.updatedAt);
      this.acquireLease(deployment, now);
      try {
        if (action === 'deploy' || action === 'rollback') {
          const artifact = this.findArtifact(state.artifacts, targetArtifactId, scope);
          if (artifact === undefined || !artifact.workflows.some((workflow) => workflow.id === deployment.workflowId)) throw new Error('Deployment artifact is not available for this workflow.');
          if (action === 'rollback' && (!deployment.healthyArtifactIds.includes(targetArtifactId) || targetArtifactId === deployment.artifactId)) throw new Error('Rollback requires a prior healthy artifact for this deployment.');
          if ((action === 'deploy' || action === 'rollback') && isProtectedEnvironment(deployment.environment)) {
            this.requirePromotionEvidence(state, deployment, scope, options.runId, targetArtifactId, options.approvalId);
          }
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
        if (action === 'deploy' && isProtectedEnvironment(deployment.environment) && deployment.observedState === 'live' && deployment.health === 'healthy') {
          deployment.lastVerifiedRunId = options.runId;
        }
        deployment.updatedAt = now;
        const transition: DeploymentTransition = {
          id: randomUUID(), action, actor, occurredAt: now,
          ...(fromArtifactId === undefined ? {} : { fromArtifactId }),
          ...(targetArtifactId === undefined ? {} : { toArtifactId: targetArtifactId }),
          ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
          ...(options.runId === undefined ? {} : { runId: options.runId, correlationId: `${options.runId}:${deployment.id}:${action}` }),
          outcome: 'succeeded',
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        };
        deployment.history.unshift(transition);
        applied = true;
        return deployment;
      } catch (error) {
        deployment.observedState = 'failed';
        deployment.health = 'degraded';
        deployment.lastError = error instanceof Error ? error.message : 'Deployment transition failed.';
        deployment.updatedAt = now;
        const transition: DeploymentTransition = { id: randomUUID(), action, actor, occurredAt: now, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }), ...(options.runId === undefined ? {} : { runId: options.runId, correlationId: `${options.runId}:${deployment.id}:${action}` }), outcome: 'failed', reason: deployment.lastError };
        deployment.history.unshift(transition);
        applied = true;
        transitionError = error;
        return deployment;
      } finally {
        delete deployment.lease;
      }
    });
    if (applied && this.events !== undefined) {
      const transition = result.history[0];
      if (transition !== undefined) await this.recordTransition(id, scope, result, transition, transitionError);
    }
    if (transitionError !== undefined) throw transitionError;
    return result;
  }

  private async recordTransition(id: string, scope: DeploymentScope, deployment: DeploymentRecord, transition: DeploymentTransition, transitionError: unknown): Promise<void> {
    const runId = transition.runId ?? `deployment:${id}`;
    const correlationId = transition.correlationId ?? `deployment:${id}:${transition.id}`;
    const operation = `deployment.${transition.action}`;
    const status = transition.outcome === 'succeeded' ? 'succeeded' : 'failed';
    await this.events?.recordEvidence({
      runId,
      deploymentId: id,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      unitId: `deployment:${id}`,
      operation,
      idempotencyKey: transition.idempotencyKey ?? transition.id,
      actor: transition.actor,
      source: 'deployment-reconciler',
      correlationId,
      status,
      error: transitionError instanceof Error ? transitionError.message : transition.reason,
      metadata: {
        'deployment.id': id,
        'deployment.environment': deployment.environment,
        'deployment.artifact': deployment.artifactId,
        'deployment.desired_state': deployment.desiredState,
        'deployment.observed_state': deployment.observedState,
        'deployment.health': deployment.health,
      },
    });
    await this.events?.emit(runId, 'deployment.transition', `${operation} ${status}.`, {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      // Run-backed deployment transitions inherit the run trace so deployment
      // evidence joins the same parent/child tree as the workflow signals.
      // Reconciler-only transitions have no run and retain a deterministic
      // deployment trace identity.
      ...(transition.runId === undefined ? { traceId: correlationId.replaceAll('-', '').padEnd(32, '0').slice(0, 32) } : {}),
      signal: 'trace',
      spanKind: 'tool',
      severityText: status === 'succeeded' ? 'INFO' : 'ERROR',
      attributes: {
        'deployment.id': id,
        'deployment.action': transition.action,
        'deployment.status': status,
        'deployment.environment': deployment.environment,
      },
    });
  }

  public async reconcile(id: string, scope: DeploymentScope): Promise<DeploymentRecord> {
    let transitionError: unknown;
    let transitionToRecord: DeploymentTransition | undefined;
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
          const transition: DeploymentTransition = {
            id: randomUUID(),
            action: targetObserved === 'live' ? 'start' : 'stop',
            actor: 'reconciler',
            occurredAt: now.toISOString(),
            fromArtifactId: deployment.artifactId,
            toArtifactId: deployment.artifactId,
            outcome: 'succeeded',
            reason: 'Desired state reconciled.',
          };
          deployment.observedState = targetObserved;
          deployment.health = observation.health;
          deployment.history.unshift(transition);
          transitionToRecord = transition;
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
          const transition: DeploymentTransition = {
            id: randomUUID(),
            action: deployment.desiredState === 'running' ? 'start' : 'stop',
            actor: 'reconciler',
            occurredAt: now.toISOString(),
            fromArtifactId: deployment.artifactId,
            toArtifactId: deployment.artifactId,
            outcome: 'failed',
            reason: message,
          };
          deployment.history.unshift(transition);
          transitionToRecord = transition;
        }
        transitionError = error;
      } finally {
        delete deployment.lease;
      }
      return deployment;
    });
    if (transitionToRecord !== undefined && this.events !== undefined) await this.recordTransition(id, scope, result, transitionToRecord, transitionError);
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

  private requirePromotionEvidence(
    state: PlatformState,
    deployment: DeploymentRecord,
    scope: DeploymentScope,
    runId: string | undefined,
    artifactId: string,
    approvalId: string | undefined,
  ): void {
    this.requireSuccessfulPromotionEvidence(state, deployment, scope, runId, artifactId);
    const approval = approvalId === undefined ? undefined : state.deploymentApprovals.find((candidate) => candidate.id === approvalId && candidate.deploymentId === deployment.id && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
    if (approval === undefined || approval.decision !== 'approved' || approval.artifactId !== artifactId || approval.runId !== runId || approval.bindingHash !== deploymentApprovalBindingHash(deployment.id, artifactId, runId ?? '')) {
      throw new Error('Protected deployment requires an approved deployment approval bound to the selected artifact and run.');
    }
  }

  private requireSuccessfulPromotionEvidence(
    state: PlatformState,
    deployment: DeploymentRecord,
    scope: DeploymentScope,
    runId: string | undefined,
    artifactId: string,
  ): void {
    if (runId === undefined || runId.trim() === '') {
      throw new Error('Protected deployment environments require a successful coding-workflow run.');
    }
    const run = state.runs.find((candidate) => candidate.id === runId && candidate.tenantId === scope.tenantId && candidate.projectId === scope.projectId);
    if (run === undefined || run.workflowId !== deployment.workflowId || run.status !== 'succeeded' || run.artifactId !== artifactId) {
      throw new Error('Protected deployment requires a succeeded run for the selected workflow and artifact.');
    }
    const runEvidence = state.evidence.filter((entry) => entry.runId === runId);
    const hasReviewablePatch = runEvidence.some((entry) => entry.status === 'succeeded' && (entry.operation === 'repositoryPatch' || entry.operation === 'repositoryMutation'));
    const hasPassingChecks = runEvidence.some((entry) => entry.status === 'succeeded' && entry.operation === 'repositoryCi' && entry.metadata?.['ci.status'] === 'success');
    if (!hasReviewablePatch || !hasPassingChecks) {
      throw new Error('Protected deployment requires a succeeded reviewable patch and passing required checks.');
    }
  }
}

function deploymentApprovalBindingHash(deploymentId: string, artifactId: string, runId: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ deploymentId, artifactId, runId })).digest('hex')}`;
}
