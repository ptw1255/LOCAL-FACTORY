import { createHash, randomUUID } from 'node:crypto';

import type {
  ApprovalRecord,
  AgentDefinition,
  AgentModelRoute,
  RunRecord,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '../domain/types.js';
import { validateWorkflow } from '../domain/validator.js';
import { validateWorkflowInput } from '../domain/input-schema.js';
import type { EventService } from '../observability/event-service.js';
import type { PlatformStore } from '../storage/store.js';
import { HttpOllamaClient, type OllamaClient, type OllamaModelResult } from './ollama.js';
import { WorkUnitDispatcher } from './work-unit-dispatcher.js';
import type { RepositoryWorkspace } from '../repository/workspace.js';
import { parseRepositoryCheckSandbox, RepositoryCheckError, RepositoryCheckTimeoutError, RepositoryConflictError, RepositoryMutationError, RepositoryPolicyError } from '../repository/workspace.js';
import { RepositoryCiError, type GitHubRepositoryClient } from '../repository/github.js';
import type { OpenAIClient, OpenAIModelResult } from './openai.js';
import { evaluatePolicy, PolicyDeniedError } from '../domain/policy.js';

const MAX_WAIT_MS = 5_000;
const HTTP_TIMEOUT_MS = 10_000;
const APPROVAL_TTL_MS = 30 * 60 * 1_000;

export interface RunCreationOptions {
  artifactId?: string;
  replayOfRunId?: string;
  environment?: string;
  deploymentId?: string;
  input?: unknown;
  executionEngine?: 'local' | 'temporal';
  temporalWorkflowId?: string;
  temporalRunId?: string;
  temporalTaskQueue?: string;
  retryIdempotencyKey?: string;
}

/** Stable identity for the workflow and versioned agent boxes executed by a run. */
export function releaseBundleHash(workflow: WorkflowDefinition): string {
  const bundle = {
    workflow: { id: workflow.id, version: workflow.version },
    agents: [...workflow.agents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => ({ id: agent.id, version: agent.version })),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(bundle)).digest('hex')}`;
}

function pinnedAgentVersions(workflow: WorkflowDefinition): Record<string, number> {
  return Object.fromEntries([...workflow.agents].sort((left, right) => left.id.localeCompare(right.id)).map((agent) => [agent.id, agent.version]));
}

/** Build a validated, immutable-definition run record for any execution plane. */
export function createQueuedRun(workflow: WorkflowDefinition, options: RunCreationOptions = {}): RunRecord {
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    const message = validation.issues
      .filter((issue) => issue.level === 'error')
      .map((issue) => issue.message)
      .join(' ');
    throw new Error(`Workflow is not executable. ${message}`);
  }
  const inputValidation = validateWorkflowInput(workflow.inputSchema, options.input);
  if (!inputValidation.valid) {
    throw new Error(`Workflow input is invalid. ${inputValidation.issues.map((issue) => issue.message).join(' ')}`);
  }
  const trigger = workflow.nodes.find((node) => node.type === workflow.trigger.type);
  if (trigger === undefined) throw new Error('The declared workflow trigger node is missing.');
  const now = new Date().toISOString();
  return {
    ...(workflow.tenantId === undefined ? {} : { tenantId: workflow.tenantId }),
    ...(workflow.projectId === undefined ? {} : { projectId: workflow.projectId }),
    id: randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersion: workflow.version,
    releaseBundleHash: releaseBundleHash(workflow),
    pinnedAgentVersions: pinnedAgentVersions(workflow),
    ...(options.artifactId === undefined ? {} : { artifactId: options.artifactId }),
    environment: options.environment?.trim() || 'local',
    ...(options.deploymentId === undefined ? {} : { deploymentId: options.deploymentId }),
    ...(options.input === undefined ? {} : {
      input: structuredClone(options.input),
      inputHash: createHash('sha256').update(JSON.stringify(options.input) ?? 'undefined').digest('hex'),
    }),
    ...(options.replayOfRunId === undefined ? {} : { replayOfRunId: options.replayOfRunId }),
    ...(options.retryIdempotencyKey === undefined ? {} : { retryIdempotencyKey: options.retryIdempotencyKey }),
    executionEngine: options.executionEngine ?? 'local',
    ...(options.temporalWorkflowId === undefined ? {} : { temporalWorkflowId: options.temporalWorkflowId }),
    ...(options.temporalRunId === undefined ? {} : { temporalRunId: options.temporalRunId }),
    ...(options.temporalTaskQueue === undefined ? {} : { temporalTaskQueue: options.temporalTaskQueue }),
    traceId: randomUUID().replaceAll('-', '').slice(0, 32),
    status: 'queued',
    startedAt: now,
    costUsd: 0,
    humanTouchpoints: 0,
    workflowDefinition: structuredClone(workflow),
    completedNodeIds: [],
    activatedNodeIds: [trigger.id],
    approvedNodeIds: [],
    approvedNodeHashes: {},
    pendingApprovalHashes: {},
    unitOutputs: {},
    agentCheckpoints: {},
    ciCheckpoints: {},
  };
}

export interface AgentToolExecutionContext {
  runId: string;
  nodeId: string;
  agentId: string;
  callId: string;
  name: string;
  arguments: unknown;
  signal: AbortSignal;
}

export type AgentToolRecoveryResolution = 'succeeded' | 'failed';

export interface AgentToolRecoveryRequest {
  unitId: string;
  callId: string;
  resolution: AgentToolRecoveryResolution;
  reason: string;
  actor?: string;
  outputHash?: string;
}

export type AgentToolExecutor = (context: AgentToolExecutionContext) => Promise<unknown> | unknown;

function sleep(durationMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, durationMs);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function edgeMatches(edge: WorkflowEdge, result: unknown): boolean {
  if (edge.condition === undefined || edge.condition.trim() === '') {
    return true;
  }
  const condition = edge.condition.trim().toLowerCase();
  if (result !== null && typeof result === 'object' && typeof (result as { status?: unknown }).status === 'string') {
    return condition === String((result as { status: string }).status).toLowerCase();
  }
  return condition === String(result).toLowerCase();
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export class LocalWorkflowExecutor {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly pendingResumes = new Set<string>();
  private readonly runWorkspaces = new Map<string, RepositoryWorkspace>();
  private readonly ownerId = `executor-${randomUUID()}`;
  private readonly executionLeaseMs = 30_000;

  public constructor(
    private readonly store: PlatformStore,
    private readonly events: EventService,
    private readonly ollama: OllamaClient = new HttpOllamaClient(),
    private readonly dispatcher: WorkUnitDispatcher = new WorkUnitDispatcher(),
    private readonly repositoryWorkspace?: RepositoryWorkspace,
    private readonly githubRepository?: GitHubRepositoryClient,
    private readonly openai?: OpenAIClient,
    private readonly toolExecutors: ReadonlyMap<string, AgentToolExecutor> = new Map(),
    private readonly openaiCompatible?: OpenAIClient,
    private readonly providerClients: ReadonlyMap<string, OpenAIClient> = new Map(),
  ) {}

  public async recover(): Promise<number> {
    const runIds = await this.store.read((state) =>
      state.runs
        .filter((run) => ['queued', 'running'].includes(run.status))
        .map((run) => run.id),
    );
    let recovered = 0;
    for (const runId of runIds) {
      if (!await this.claimExecutionLease(runId)) continue;
      recovered += 1;
      await this.events.emit(runId, 'run.recovered', 'Resuming run from its last persisted node checkpoint.');
      void this.execute(runId, true);
    }
    return recovered;
  }

  public async start(workflow: WorkflowDefinition, options: RunCreationOptions = {}): Promise<RunRecord> {
    const run = createQueuedRun(workflow, { ...options, executionEngine: 'local' });

    await this.store.mutate((state) => {
      state.runs.unshift(run);
    });
    await this.events.emit(run.id, 'run.queued', 'Workflow run queued.');
    void this.execute(run.id);
    return run;
  }

  /** Start a fresh, pinned run from a terminal failure while preserving provenance. */
  public async retry(runId: string, options: { idempotencyKey?: string } = {}): Promise<RunRecord> {
    const source = await this.store.read((state) => state.runs.find((candidate) => candidate.id === runId));
    if (source === undefined) throw new Error('Run not found.');
    if (!['failed', 'timed_out', 'cancelled'].includes(source.status)) {
      throw new Error('Only failed, timed-out, or cancelled runs can be retried.');
    }
    const idempotencyKey = options.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== '') {
      const existing = await this.store.read((state) => state.runs.find((candidate) => candidate.retryIdempotencyKey === idempotencyKey));
      if (existing !== undefined) {
        if (existing.replayOfRunId !== source.id) throw new Error('Retry idempotency key is already associated with another source run.');
        return existing;
      }
    }
    const retry = await this.start(source.workflowDefinition, {
      ...(source.artifactId === undefined ? {} : { artifactId: source.artifactId }),
      ...(source.environment === undefined ? {} : { environment: source.environment }),
      ...(source.deploymentId === undefined ? {} : { deploymentId: source.deploymentId }),
      ...(source.input === undefined ? {} : { input: structuredClone(source.input) }),
      replayOfRunId: source.id,
      ...(idempotencyKey === undefined || idempotencyKey === '' ? {} : { retryIdempotencyKey: idempotencyKey }),
    });
    await this.events.emit(source.id, 'run.retried', `Run retried as ${retry.id}.`, { attributes: { 'run.retry_id': retry.id } });
    return retry;
  }

  /** Request a cooperative pause at the next safe WorkUnit boundary. */
  public async pause(runId: string): Promise<RunRecord> {
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) throw new Error('Run not found.');
      if (!['queued', 'running'].includes(target.status)) {
        throw new Error('Only queued or running runs can be paused.');
      }
      target.status = 'paused';
      return target;
    });
    await this.events.emit(runId, 'run.paused', 'Workflow run paused at a safe WorkUnit boundary.');
    return run;
  }

  /** Resume a locally persisted run without replaying completed WorkUnits. */
  public async resume(runId: string): Promise<RunRecord> {
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) throw new Error('Run not found.');
      if (target.status !== 'paused') throw new Error('Only paused runs can be resumed.');
      target.status = 'queued';
      return target;
    });
    await this.events.emit(runId, 'run.resumed', 'Workflow run resumed from its persisted checkpoint.');
    void this.execute(runId);
    return run;
  }

  /**
   * Resolve an incomplete tool checkpoint without replaying the side effect.
   * A confirmed success leaves the run paused so an operator must explicitly
   * resume it; a confirmed failure keeps the run terminal for a normal retry.
   */
  public async recoverToolCheckpoint(runId: string, request: AgentToolRecoveryRequest): Promise<RunRecord> {
    const reason = request.reason.trim();
    if (reason === '') throw new Error('A recovery reason is required.');
    if (request.resolution === 'succeeded' && !/^[a-f0-9]{64}$/i.test(request.outputHash ?? '')) {
      throw new Error('A sha256 outputHash is required when confirming tool success.');
    }
    const context = await this.store.read((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return undefined;
      const started = state.evidence.find((evidence) =>
        evidence.runId === runId
        && evidence.unitId === request.unitId
        && evidence.operation === 'agent.tool'
        && evidence.idempotencyKey === `${request.callId}:started`
        && evidence.status === 'started',
      );
      const succeeded = state.evidence.find((evidence) =>
        evidence.runId === runId
        && evidence.unitId === request.unitId
        && evidence.operation === 'agent.tool'
        && evidence.idempotencyKey === `${request.callId}:succeeded`
        && evidence.status === 'succeeded',
      );
      return { run, started, succeeded };
    });
    if (context === undefined) throw new Error('Run not found.');
    if (!['failed', 'paused'].includes(context.run.status)) throw new Error('Tool recovery is only available for failed or paused runs.');
    if (context.started === undefined) throw new Error('Incomplete tool checkpoint was not found.');
    if (context.succeeded !== undefined) throw new Error('Tool checkpoint is already resolved as succeeded.');

    const metadata = {
      'tool.recovery': 'manual',
      'tool.call_id': request.callId,
      ...(request.outputHash === undefined ? {} : { 'tool.output_hash': request.outputHash.toLowerCase() }),
    };
    await this.events.recordEvidence({
      runId,
      unitId: request.unitId,
      operation: 'agent.tool',
      idempotencyKey: `${request.callId}:recovered`,
      actor: request.actor?.trim() || 'local-operator',
      source: 'operator-recovery',
      status: request.resolution,
      error: request.resolution === 'failed' ? reason : undefined,
      metadata,
    });
    await this.events.emit(runId, 'agent.tool.recovery', `Operator resolved incomplete agent tool ${request.callId} as ${request.resolution}.`, {
      nodeId: request.unitId,
      signal: 'log',
      spanKind: 'tool',
      severityText: request.resolution === 'failed' ? 'WARN' : 'INFO',
      attributes: {
        'openinference.span.kind': 'TOOL',
        'tool.call_id': request.callId,
        'tool.recovery': 'manual',
        'tool.recovery.resolution': request.resolution,
      },
      data: { reason },
    });
    if (request.resolution === 'succeeded') {
      return await this.store.mutate((state) => {
        const run = state.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) throw new Error('Run not found.');
        run.status = 'paused';
        delete run.error;
        delete run.completedAt;
        delete run.durationMs;
        return run;
      });
    }
    return context.run;
  }

  public async approve(runId: string, options: { actor?: string; reason?: string } = {}): Promise<RunRecord> {
    let expired = false;
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) {
        throw new Error('Run not found.');
      }
      if (target.status !== 'waiting') {
        throw new Error('Only waiting runs can be approved.');
      }
      const waitingNode = target.workflowDefinition.nodes.find((node) =>
        this.requiresApproval(node, target.workflowDefinition) && target.activatedNodeIds.includes(node.id) && !target.completedNodeIds.includes(node.id));
      if (waitingNode === undefined) {
        throw new Error('No approval node is waiting.');
      }
      const expectedHash = target.pendingApprovalHashes[waitingNode.id];
      const currentHash = this.approvalFingerprint(target, waitingNode);
      if (expectedHash === undefined || expectedHash !== currentHash) {
        throw new Error('Approval is no longer valid because the approved operation changed.');
      }
      const approval = state.approvals.find((candidate) => candidate.runId === runId && candidate.nodeId === waitingNode.id && candidate.decision === 'pending');
      if (approval === undefined) throw new Error('Approval record is missing or no longer pending.');
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        approval.decision = 'expired';
        approval.decidedAt = new Date().toISOString();
        target.status = 'failed';
        target.error = 'Approval expired before it was received.';
        target.completedAt = approval.decidedAt;
        expired = true;
        return target;
      }
      target.approvedNodeIds.push(waitingNode.id);
      target.approvedNodeHashes[waitingNode.id] = currentHash;
      delete target.pendingApprovalHashes[waitingNode.id];
      target.humanTouchpoints += 1;
      target.status = 'queued';
      approval.decision = 'approved';
      approval.actor = options.actor?.trim() || 'local-operator';
      approval.reason = options.reason;
      approval.decidedAt = new Date().toISOString();
      return target;
    });

    if (expired) {
      await this.events.emit(runId, 'approval.expired', 'Approval expired before it was received.', { severityText: 'WARN' });
      throw new Error('Approval expired before it was received.');
    }
    await this.events.emit(runId, 'approval.received', 'Human approval received.');
    // If the waiting execution is still unwinding, execute() records a pending
    // resume and the owner drains it after releasing the active-run guard.
    void this.execute(runId);
    return run;
  }

  public async deny(runId: string, options: { actor?: string; reason?: string } = {}): Promise<RunRecord> {
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) throw new Error('Run not found.');
      if (target.status !== 'waiting') throw new Error('Only waiting runs can be denied.');
      const waitingNode = target.workflowDefinition.nodes.find((node) => this.requiresApproval(node, target.workflowDefinition) && target.activatedNodeIds.includes(node.id) && !target.completedNodeIds.includes(node.id));
      if (waitingNode === undefined) throw new Error('No approval node is waiting.');
      const approval = state.approvals.find((candidate) => candidate.runId === runId && candidate.nodeId === waitingNode.id && candidate.decision === 'pending');
      if (approval === undefined) throw new Error('Approval record is missing or no longer pending.');
      const now = new Date().toISOString();
      approval.decision = 'denied';
      approval.actor = options.actor?.trim() || 'local-operator';
      approval.reason = options.reason;
      approval.decidedAt = now;
      target.status = 'failed';
      target.error = options.reason?.trim() || 'Workflow approval was denied.';
      target.completedAt = now;
      delete target.pendingApprovalHashes[waitingNode.id];
      return target;
    });
    await this.events.emit(runId, 'approval.denied', 'Workflow approval was denied.', { severityText: 'WARN' });
    return run;
  }

  public async expire(runId: string, options: { actor?: string; reason?: string } = {}): Promise<RunRecord> {
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) throw new Error('Run not found.');
      if (target.status !== 'waiting') throw new Error('Only waiting runs can expire an approval.');
      const waitingNode = target.workflowDefinition.nodes.find((node) => this.requiresApproval(node, target.workflowDefinition) && target.activatedNodeIds.includes(node.id) && !target.completedNodeIds.includes(node.id));
      if (waitingNode === undefined) throw new Error('No approval node is waiting.');
      const approval = state.approvals.find((candidate) => candidate.runId === runId && candidate.nodeId === waitingNode.id && candidate.decision === 'pending');
      if (approval === undefined) throw new Error('Approval record is missing or no longer pending.');
      const now = new Date().toISOString();
      approval.decision = 'expired';
      approval.actor = options.actor?.trim() || 'local-operator';
      approval.reason = options.reason?.trim() || 'Approval expired by operator.';
      approval.decidedAt = now;
      target.status = 'failed';
      target.error = approval.reason;
      target.completedAt = now;
      delete target.pendingApprovalHashes[waitingNode.id];
      return target;
    });
    await this.events.emit(runId, 'approval.expired', 'Workflow approval expired.', { severityText: 'WARN' });
    return run;
  }

  public async supersede(runId: string, options: { actor?: string; reason?: string } = {}): Promise<RunRecord> {
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) throw new Error('Run not found.');
      if (target.status !== 'waiting') throw new Error('Only waiting runs can supersede an approval.');
      const waitingNode = target.workflowDefinition.nodes.find((node) => this.requiresApproval(node, target.workflowDefinition) && target.activatedNodeIds.includes(node.id) && !target.completedNodeIds.includes(node.id));
      if (waitingNode === undefined) throw new Error('No approval node is waiting.');
      const approval = state.approvals.find((candidate) => candidate.runId === runId && candidate.nodeId === waitingNode.id && candidate.decision === 'pending');
      if (approval === undefined) throw new Error('Approval record is missing or no longer pending.');
      const now = new Date().toISOString();
      approval.decision = 'superseded';
      approval.actor = options.actor?.trim() || 'local-operator';
      approval.reason = options.reason?.trim() || 'Approval superseded by operator.';
      approval.decidedAt = now;
      delete target.pendingApprovalHashes[waitingNode.id];
      target.status = 'queued';
      return target;
    });
    await this.events.emit(runId, 'approval.superseded', 'Workflow approval superseded; a fresh approval is required.', { severityText: 'WARN' });
    void this.execute(runId);
    return run;
  }

  public async cancel(runId: string): Promise<RunRecord> {
    const completedAt = new Date();
    let cancelledApproval = false;
    const run = await this.store.mutate((state) => {
      const target = state.runs.find((candidate) => candidate.id === runId);
      if (target === undefined) {
        throw new Error('Run not found.');
      }
      if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(target.status)) {
        throw new Error('Completed runs cannot be cancelled.');
      }
      target.status = 'cancelled';
      target.completedAt = completedAt.toISOString();
      target.durationMs =
        completedAt.getTime() - new Date(target.startedAt).getTime();
      for (const approval of state.approvals.filter((candidate) => candidate.runId === runId && candidate.decision === 'pending')) {
        approval.decision = 'cancelled';
        approval.decidedAt = completedAt.toISOString();
        cancelledApproval = true;
      }
      return target;
    });
    this.activeRuns.get(runId)?.abort(
      new Error('Workflow run was cancelled by an operator.'),
    );
    await this.events.emit(runId, 'run.cancelled', 'Workflow run cancelled.');
    if (cancelledApproval) await this.events.emit(runId, 'approval.cancelled', 'Pending workflow approval cancelled.', { severityText: 'WARN' });
    return run;
  }

  public async execute(runId: string, leaseClaimed = false): Promise<void> {
    if (this.activeRuns.has(runId)) {
      this.pendingResumes.add(runId);
      return;
    }
    if (!leaseClaimed && !await this.claimExecutionLease(runId)) return;
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    const leaseRenewal = setInterval(() => {
      void this.renewExecutionLease(runId).then((held) => {
        if (!held && !controller.signal.aborted) controller.abort(new Error('Execution lease was lost to another worker.'));
      }).catch(() => {
        if (!controller.signal.aborted) controller.abort(new Error('Execution lease could not be renewed.'));
      });
    }, Math.max(1_000, Math.floor(this.executionLeaseMs / 3)));

    try {
      const started = await this.transitionToRunning(runId);
      if (!started) {
        return;
      }
      await this.events.emit(runId, 'run.started', 'Workflow run started.');

      while (true) {
        const context = await this.store.read((state) => {
          const run = state.runs.find((candidate) => candidate.id === runId);
          const workflow = run?.workflowDefinition;
          return { run, workflow };
        });

        if (context.run === undefined || context.workflow === undefined) {
          throw new Error('Run or workflow definition no longer exists.');
        }
        if (context.run.status === 'cancelled' || context.run.status === 'paused') {
          return;
        }

        const nextNode = this.findReadyNode(context.workflow, context.run);
        if (nextNode === undefined) {
          const unfinished = context.run.activatedNodeIds.filter(
            (nodeId) => !context.run?.completedNodeIds.includes(nodeId),
          );
          if (unfinished.length > 0) {
            await this.waitForApproval(runId, unfinished[0] ?? '');
            return;
          }
          await this.completeRun(runId);
          return;
        }

        if (this.requiresApproval(nextNode, context.workflow) && !context.run.approvedNodeIds.includes(nextNode.id)) {
          await this.waitForApproval(runId, nextNode.id);
          return;
        }
        if (this.requiresApproval(nextNode, context.workflow) && context.run.approvedNodeHashes[nextNode.id] !== this.approvalFingerprint(context.run, nextNode)) {
          await this.store.mutate((state) => {
            const run = state.runs.find((candidate) => candidate.id === runId);
            if (run === undefined) return;
            run.approvedNodeIds = run.approvedNodeIds.filter((nodeId) => nodeId !== nextNode.id);
            delete run.approvedNodeHashes[nextNode.id];
          });
          await this.waitForApproval(runId, nextNode.id);
          return;
        }

        const currentRun = context.run;
        const unitStartedAt = Date.now();
        const persistedInputs = context.workflow.edges
          .filter((edge) => edge.target === nextNode.id && currentRun.unitOutputs[edge.source] !== undefined)
          .map((edge) => currentRun.unitOutputs[edge.source]);
        const initialInput = currentRun.completedNodeIds.length === 0
          && nextNode.type === context.workflow.trigger.type
          && currentRun.input !== undefined
          ? [currentRun.input]
          : persistedInputs;
        const inputs = await Promise.all(initialInput.map((input) => this.events.resolvePayload(input)));
        const unitEvidenceKey = nextNode.unit?.idempotencyKey ?? `run:${runId}:unit:${nextNode.id}`;
        await this.events.recordEvidence({
          runId,
          unitId: nextNode.id,
          operation: nextNode.type,
          idempotencyKey: `${unitEvidenceKey}:started`,
          status: 'started',
          input: inputs,
          metadata: { 'work.unit.kind': nextNode.unit?.kind ?? 'unknown', 'work.unit.version': nextNode.unit?.version ?? 0 },
        });
        await this.events.emit(runId, 'unit.started', `${nextNode.label} unit started.`, {
          nodeId: nextNode.id,
          signal: 'trace',
          spanKind: nextNode.unit?.kind === 'agent' ? 'agent' : 'chain',
          attributes: {
            'work.unit.kind': nextNode.unit?.kind ?? 'unknown',
            'work.unit.version': nextNode.unit?.version ?? 0,
            'work.unit.input_schema': nextNode.unit?.inputSchema ?? 'unknown',
            'work.unit.output_schema': nextNode.unit?.outputSchema ?? 'unknown',
            ...this.sourceMetadata(nextNode),
          },
        });
        try {
          const result = await this.executeNode(
            runId,
            currentRun.traceId,
            nextNode,
            controller.signal,
            inputs,
            currentRun.completedNodeIds.length + 1,
          );
          await this.events.emit(runId, 'unit.output.produced', `${nextNode.label} produced output.`, {
            nodeId: nextNode.id,
            signal: 'trace',
            spanKind: nextNode.unit?.kind === 'agent' ? 'agent' : 'chain',
            attributes: { 'work.unit.output_schema': nextNode.unit?.outputSchema ?? 'unknown', ...this.sourceMetadata(nextNode) },
          });
          const persistedResult = await this.events.offloadPayload(runId, result, `unit:${nextNode.type}`);
          const completed = await this.completeNode(context.run.id, context.workflow, nextNode, result, persistedResult);
          if (!completed) {
            await this.events.recordEvidence({ runId, unitId: nextNode.id, operation: nextNode.type, status: 'cancelled', idempotencyKey: `${unitEvidenceKey}:cancelled`, output: result });
            return;
          }
          await this.events.recordEvidence({
            runId,
            unitId: nextNode.id,
            operation: nextNode.type,
            status: 'succeeded',
            idempotencyKey: `${unitEvidenceKey}:succeeded`,
            output: result,
            metadata: {
              ...(this.operationMetadata(result) ?? {}),
              ...(this.operationMetadata(persistedResult) ?? {}),
            },
          });
          await this.events.emit(runId, 'unit.completed', `${nextNode.label} unit completed.`, {
            nodeId: nextNode.id,
            signal: 'trace',
            spanKind: nextNode.unit?.kind === 'agent' ? 'agent' : 'chain',
            attributes: {
              'work.unit.duration_ms': Date.now() - unitStartedAt,
              'work.unit.status': 'completed',
              ...this.sourceMetadata(nextNode),
            },
          });
          await this.events.emit(runId, 'unit.duration', `${nextNode.label} duration recorded.`, {
            nodeId: nextNode.id,
            signal: 'metric',
            attributes: {
              'metric.name': 'unit.duration_ms',
              'metric.value': Date.now() - unitStartedAt,
              'work.unit.kind': nextNode.unit?.kind ?? 'unknown',
              ...this.sourceMetadata(nextNode),
            },
          });
        } catch (error) {
          const failureMetadata = error instanceof RepositoryCheckError || error instanceof RepositoryCheckTimeoutError
            ? {
              ...(this.operationMetadata(error.result) ?? {}),
              ...(this.operationMetadata(await this.events.offloadPayload(runId, error.result, `unit:${nextNode.type}`)) ?? {}),
            }
            : undefined;
          await this.events.recordEvidence({
            runId,
            unitId: nextNode.id,
            operation: nextNode.type,
            status: controller.signal.aborted ? 'cancelled' : error instanceof Error && 'code' in error && ['WORK_UNIT_TIMED_OUT', 'REPOSITORY_CHECK_TIMED_OUT'].includes(String(error.code)) ? 'timed_out' : 'failed',
            idempotencyKey: `${unitEvidenceKey}:failed`,
            error: error instanceof Error ? error.message : 'Unknown unit failure.',
            metadata: failureMetadata ?? (error instanceof RepositoryCiError
              ? this.operationMetadata(error.result)
              : error instanceof RepositoryMutationError
                ? this.operationMetadata(error)
              : error instanceof RepositoryConflictError || error instanceof RepositoryPolicyError
                ? this.operationMetadata(error)
                : error instanceof RepositoryCheckError || error instanceof RepositoryCheckTimeoutError
                  ? this.operationMetadata(error.result)
                : undefined),
          });
          await this.events.emit(runId, 'unit.failed', `${nextNode.label} unit failed.`, {
            nodeId: nextNode.id,
            severityText: 'ERROR',
            attributes: {
              'work.unit.duration_ms': Date.now() - unitStartedAt,
              'work.unit.status': 'failed',
              ...this.sourceMetadata(nextNode),
            },
            data: { error: error instanceof Error ? error.message : 'Unknown unit failure.' },
          });
          throw error;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Unknown execution failure.';
      const timedOut = error instanceof Error && 'code' in error && ['WORK_UNIT_TIMED_OUT', 'REPOSITORY_CHECK_TIMED_OUT'].includes(String(error.code));
      await this.failRun(runId, message, timedOut ? 'timed_out' : 'failed');
    } finally {
      clearInterval(leaseRenewal);
      await this.releaseExecutionLease(runId);
      if (this.activeRuns.get(runId) === controller) {
        this.activeRuns.delete(runId);
        if (this.pendingResumes.delete(runId)) void this.execute(runId);
      }
    }
  }

  /** Atomically claim a queued/running run so only one process can execute it. */
  private async claimExecutionLease(runId: string): Promise<boolean> {
    const now = Date.now();
    return this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || !['queued', 'running'].includes(run.status)) return false;
      const current = run.executionLease;
      if (current !== undefined && Date.parse(current.expiresAt) > now) return false;
      run.executionLease = {
        ownerId: this.ownerId,
        expiresAt: new Date(now + this.executionLeaseMs).toISOString(),
      };
      return true;
    });
  }

  private async renewExecutionLease(runId: string): Promise<boolean> {
    const now = Date.now();
    return this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.executionLease?.ownerId !== this.ownerId) return false;
      run.executionLease.expiresAt = new Date(now + this.executionLeaseMs).toISOString();
      return true;
    });
  }

  private async releaseExecutionLease(runId: string): Promise<void> {
    await this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run?.executionLease?.ownerId === this.ownerId) delete run.executionLease;
    }).catch(() => undefined);
  }

  private findReadyNode(
    workflow: WorkflowDefinition,
    run: RunRecord,
  ): WorkflowNode | undefined {
    return workflow.nodes.find((node) => {
      if (
        !run.activatedNodeIds.includes(node.id) ||
        run.completedNodeIds.includes(node.id)
      ) {
        return false;
      }
      const activePredecessors = workflow.edges
        .filter(
          (edge) =>
            edge.target === node.id &&
            run.activatedNodeIds.includes(edge.source),
        )
        .map((edge) => edge.source);
      return activePredecessors.every((source) =>
        run.completedNodeIds.includes(source),
      );
    });
  }

  private async executeNode(
    runId: string,
    traceId: string,
    node: WorkflowNode,
    signal: AbortSignal,
    inputs: unknown[] = [],
    sequence = 1,
  ): Promise<unknown> {
    signal.throwIfAborted();
    await this.events.emit(runId, 'node.started', `${node.label} started.`, {
      nodeId: node.id,
      signal: 'trace',
      spanKind: node.type === 'agentLoop' ? 'agent' : 'chain',
      attributes: {
        'workflow.node.type': node.type,
        'openinference.span.kind': node.type === 'agentLoop' ? 'AGENT' : 'CHAIN',
        ...this.sourceMetadata(node),
      },
      data: { nodeType: node.type },
    });

    const policy = evaluatePolicy(node.config.policyRules, {
      action: node.type,
      nodeType: node.type,
      ...(typeof node.config.operation === 'string' ? { operation: node.config.operation } : {}),
    });
    if (!policy.allowed) {
      await this.events.emit(runId, 'policy.denied', policy.reason ?? `Policy denied ${node.type}.`, {
        nodeId: node.id,
        signal: 'log',
        severityText: 'WARN',
        attributes: {
          'policy.decision': 'deny',
          ...(typeof node.config.policyId === 'string' ? { 'policy.id': node.config.policyId } : {}),
          ...this.sourceMetadata(node),
        },
      });
      throw new PolicyDeniedError(policy.reason ?? `Policy denied ${node.type}.`);
    }

    return this.dispatcher.dispatch(node.unit, {
      runId,
      traceId,
      sequence,
      node,
      inputs,
      signal,
      execute: (executionSignal = signal) => this.executeNodeImplementation(runId, traceId, node, executionSignal, inputs),
    });
  }

  private async executeNodeImplementation(
    runId: string,
    traceId: string,
    node: WorkflowNode,
    signal: AbortSignal,
    inputs: unknown[],
  ): Promise<unknown> {
    let result: unknown = true;
    switch (node.type) {
      case 'condition':
        result = node.config.result === true;
        break;
      case 'manualTrigger':
      case 'scheduleTrigger':
      case 'webhookTrigger':
        result = inputs.length === 0 ? true : inputs.length === 1 ? inputs[0] : inputs;
        break;
      case 'wait': {
        const requested =
          typeof node.config.durationMs === 'number'
            ? node.config.durationMs
            : 250;
        await sleep(Math.min(Math.max(requested, 0), MAX_WAIT_MS), signal);
        result = requested;
        break;
      }
      case 'httpRequest':
        result = await this.executeHttp(node, signal);
        break;
      case 'agentLoop':
        result = await this.executeAgentLoop(runId, traceId, node, signal);
        break;
      case 'transform':
      case 'output':
        result = node.config.value ?? true;
        break;
      case 'code':
        result = this.executeDeterministicCode(node, inputs);
        break;
      case 'evaluator': {
        const evaluation = this.executeDeterministicEvaluator(node, inputs);
        result = evaluation;
        await this.events.emit(runId, 'evaluator.completed', `${node.label} evaluator completed.`, {
          nodeId: node.id,
          signal: 'metric',
          spanKind: 'evaluator',
          attributes: {
            'openinference.span.kind': 'EVALUATOR',
            'evaluator.mode': evaluation.mode,
            'evaluator.passed': evaluation.passed,
            'evaluator.score': evaluation.score,
            'evaluator.threshold': evaluation.threshold,
            'metric.name': 'evaluator.score',
            'metric.value': evaluation.score,
          },
        });
        break;
      }
      case 'repositoryCheck': {
        const workspace = await this.workspaceForRun(runId);
        const command = typeof node.config.command === 'string' ? node.config.command : 'npm test';
        const timeoutMs = typeof node.config.timeoutMs === 'number' ? node.config.timeoutMs : undefined;
        const required = node.config.required !== false;
        const check = await workspace.runCheck(command, timeoutMs, signal, { sandbox: parseRepositoryCheckSandbox(node.config.sandbox) });
        result = { ...check, required, promotionBlocked: required && check.exitCode !== 0 };
        if (required && check.timedOut) throw new RepositoryCheckTimeoutError(`Required repository check timed out: ${command}.`, check);
        if (required && check.exitCode !== 0) throw new RepositoryCheckError(`Required repository check failed: ${command}.`, check);
        break;
      }
      case 'repositoryPatch': {
        const workspace = await this.workspaceForRun(runId);
        result = await workspace.patchArtifact();
        break;
      }
      case 'repositoryMutation': {
        const capabilities = Array.isArray(node.config.capabilities)
          ? node.config.capabilities.filter((value): value is string => typeof value === 'string')
          : [];
        if (!capabilities.includes('repository.write')) {
          throw new Error('Repository mutation requires the declared "repository.write" capability.');
        }
        const workspace = await this.workspaceForRun(runId);
        const operations = Array.isArray(node.config.operations) ? node.config.operations : [];
        const protectedPaths = Array.isArray(node.config.protectedPaths)
          ? node.config.protectedPaths.filter((value): value is string => typeof value === 'string')
          : [];
        result = await workspace.applyMutationsTransaction(operations, { protectedPaths });
        break;
      }
      case 'repositoryBranch': {
        const workspace = await this.workspaceForRun(runId);
        const branch = typeof node.config.branch === 'string' ? node.config.branch : '';
        const baseRevision = typeof node.config.baseRevision === 'string' ? node.config.baseRevision : await workspace.revision();
        result = await workspace.createBranch(branch, baseRevision);
        break;
      }
      case 'repositoryCommit': {
        const workspace = await this.workspaceForRun(runId);
        const message = typeof node.config.message === 'string' ? node.config.message : '';
        const paths = Array.isArray(node.config.paths) ? node.config.paths.filter((value): value is string => typeof value === 'string') : [];
        if (node.config.requirePatchArtifact === true) {
          const patches = inputs.map((input) => {
            if (input !== null && typeof input === 'object' && 'patch' in input && (input as { patch?: unknown }).patch !== null && typeof (input as { patch?: unknown }).patch === 'object') return (input as { patch?: unknown }).patch;
            return input;
          }).filter((input): input is { id: string; changedPaths?: unknown[] } => input !== null && typeof input === 'object' && typeof (input as { id?: unknown }).id === 'string' && Array.isArray((input as { changedPaths?: unknown[] }).changedPaths));
          if (patches.length === 0) throw new Error('Repository commit requires an upstream patch artifact.');
          if (patches.length > 1) throw new Error('Repository commit requires exactly one unambiguous upstream patch artifact.');
          const patch = patches[0]!;
          const changedPaths = patch.changedPaths?.filter((value): value is string => typeof value === 'string') ?? [];
          const selectedPaths = paths.length === 0 ? changedPaths : paths;
          if (selectedPaths.some((path) => !changedPaths.includes(path))) throw new Error('Repository commit paths must be contained in the approved patch artifact.');
          const patchFiles = (patch as { files?: unknown[] }).files;
          if (Array.isArray(patchFiles) && patchFiles.length > 0) {
            for (const selectedPath of selectedPaths) {
              const expected = patchFiles.find((file) => file !== null && typeof file === 'object' && (file as { path?: unknown }).path === selectedPath) as { path: string; sha256?: unknown } | undefined;
              if (expected === undefined) throw new Error(`Repository commit path "${selectedPath}" is missing from the approved patch file manifest.`);
              let actualSha: string | undefined;
              try { actualSha = createHash('sha256').update(await workspace.read(selectedPath)).digest('hex'); } catch { actualSha = undefined; }
              if (actualSha !== (typeof expected.sha256 === 'string' ? expected.sha256 : undefined)) throw new Error(`Repository commit content for "${selectedPath}" no longer matches the approved patch artifact.`);
            }
          }
        }
        result = await workspace.commit(message, paths);
        break;
      }
      case 'repositoryPush': {
        const workspace = await this.workspaceForRun(runId);
        const branch = typeof node.config.branch === 'string' && node.config.branch !== ''
          ? node.config.branch
          : await workspace.currentBranch();
        const remote = typeof node.config.remote === 'string' ? node.config.remote : 'origin';
        const allowedRemotes = Array.isArray(node.config.allowedRemotes)
          ? node.config.allowedRemotes.filter((value): value is string => typeof value === 'string')
          : ['origin'];
        result = await workspace.push(branch, remote, { allowedRemotes });
        break;
      }
      case 'repositoryPullRequest': {
        if (this.githubRepository === undefined) throw new Error('GitHub repository integration is not configured.');
        const title = typeof node.config.title === 'string' ? node.config.title : '';
        const body = typeof node.config.body === 'string' ? node.config.body : '';
        const head = typeof node.config.head === 'string' ? node.config.head : '';
        const base = typeof node.config.base === 'string' ? node.config.base : 'main';
        result = await this.githubRepository.createOrGetPullRequest({ title, body, head, base });
        break;
      }
      case 'repositoryCi': {
        if (this.githubRepository === undefined) throw new Error('GitHub repository integration is not configured.');
        const ref = typeof node.config.ref === 'string' && node.config.ref !== '' ? node.config.ref : await (await this.workspaceForRun(runId)).revision();
        const required = Array.isArray(node.config.required) ? node.config.required.filter((value): value is string => typeof value === 'string') : [];
        const configuredTimeoutMs = typeof node.config.timeoutMs === 'number' ? Math.max(1, node.config.timeoutMs) : 120_000;
        const configuredIntervalMs = typeof node.config.intervalMs === 'number' ? Math.max(10, node.config.intervalMs) : 2_000;
        const checkpoint = await this.store.read((state) => state.runs.find((candidate) => candidate.id === runId)?.ciCheckpoints[node.id]);
        const startedAt = checkpoint?.startedAt ?? new Date().toISOString();
        const startedAtMs = Date.parse(startedAt);
        const elapsed = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;
        const remainingTimeoutMs = checkpoint === undefined ? configuredTimeoutMs : Math.max(1, configuredTimeoutMs - Math.max(0, elapsed));
        await this.store.mutate((state) => {
          const run = state.runs.find((candidate) => candidate.id === runId);
          if (run !== undefined) {
            run.ciCheckpoints[node.id] = {
              ref,
              required,
              timeoutMs: configuredTimeoutMs,
              intervalMs: configuredIntervalMs,
              startedAt,
              polls: checkpoint?.polls ?? 0,
              lastStatus: checkpoint?.lastStatus ?? 'pending',
            };
          }
        });
        await this.events.recordEvidence({
          runId,
          unitId: node.id,
          operation: node.type,
          status: 'waiting',
          idempotencyKey: `${node.unit?.idempotencyKey ?? `run:${runId}:unit:${node.id}`}:waiting`,
          input: { ref, required },
          metadata: { 'ci.ref': ref, 'ci.required_count': required.length },
        });
        const ciResult = await this.githubRepository.waitForChecks({
          ref,
          required,
          timeoutMs: remainingTimeoutMs,
          intervalMs: configuredIntervalMs,
          signal,
          onPoll: async ({ status }) => {
            await this.store.mutate((state) => {
              const run = state.runs.find((candidate) => candidate.id === runId);
              const current = run?.ciCheckpoints[node.id];
              if (current !== undefined) {
                current.polls += 1;
                current.lastStatus = status;
              }
            });
          },
        });
        await this.store.mutate((state) => {
          const run = state.runs.find((candidate) => candidate.id === runId);
          if (run !== undefined) delete run.ciCheckpoints[node.id];
        });
        result = ciResult;
        const failurePolicy = node.config.failurePolicy === 'route' ? 'route' : 'fail';
        if (failurePolicy === 'fail' && required.length > 0 && ciResult.status !== 'success') {
          throw new RepositoryCiError(`Required GitHub checks did not pass for ${ref}: ${ciResult.status}.`, ciResult);
        }
        break;
      }
      case 'notification':
        signal.throwIfAborted();
        await this.events.emit(
          runId,
          'notification.emitted',
          String(node.config.message ?? 'Workflow notification'),
          { nodeId: node.id, data: { channel: node.config.channel ?? 'default' } },
        );
        break;
      default:
        result = true;
    }
    return result;
  }

  private executeDeterministicCode(node: WorkflowNode, inputs: unknown[]): unknown {
    const operation = typeof node.config.operation === 'string'
      ? node.config.operation
      : 'identity';
    const value = node.config.value ?? inputs[0] ?? '';
    switch (operation) {
      case 'identity':
        return value;
      case 'uppercase':
        return String(value).toUpperCase();
      case 'lowercase':
        return String(value).toLowerCase();
      case 'trim':
        return String(value).trim();
      case 'json.parse':
        return JSON.parse(String(value)) as unknown;
      case 'json.stringify':
        return JSON.stringify(value);
      default:
        throw new Error(`Unsupported deterministic code operation "${operation}".`);
    }
  }

  private executeDeterministicEvaluator(node: WorkflowNode, inputs: unknown[]): { score: number; threshold: number; passed: boolean; mode: string } {
    const mode = typeof node.config.mode === 'string' ? node.config.mode : 'equals';
    const actual = inputs.at(-1) ?? node.config.actual;
    const expected = node.config.expected;
    let matched = false;
    switch (mode) {
      case 'equals':
        matched = stableValue(actual) === stableValue(expected);
        break;
      case 'contains':
        matched = typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
        break;
      case 'fieldEquals': {
        const field = typeof node.config.field === 'string' ? node.config.field : '';
        const value = actual !== null && typeof actual === 'object' ? (actual as Record<string, unknown>)[field] : undefined;
        matched = stableValue(value) === stableValue(expected);
        break;
      }
      case 'numericGte':
        matched = typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
        break;
      case 'exists':
        matched = actual !== undefined && actual !== null;
        break;
      default:
        throw new Error(`Unsupported evaluator mode "${mode}".`);
    }
    const score = matched ? 1 : 0;
    const threshold = typeof node.config.threshold === 'number' && Number.isFinite(node.config.threshold)
      ? Math.min(Math.max(node.config.threshold, 0), 1)
      : 1;
    const result = { score, threshold, passed: score >= threshold, mode };
    if (node.config.failOnThreshold === true && result.passed === false) {
      throw new Error(`Evaluator threshold failed for mode "${mode}" (score ${score}, threshold ${threshold}).`);
    }
    return result;
  }

  private async executeHttp(
    node: WorkflowNode,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = node.config.url;
    if (typeof url !== 'string' || url.trim() === '') {
      return { simulated: true, status: 200 };
    }
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('HTTP nodes support only http and https URLs.');
    }
    const method =
      typeof node.config.method === 'string'
        ? node.config.method.toUpperCase()
        : 'GET';
    const response = await fetch(parsed, {
      method,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      throw new Error(`HTTP request failed with status ${response.status}.`);
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'unknown',
    };
  }

  private async executeAgentLoop(
    runId: string,
    traceId: string,
    node: WorkflowNode,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const agentId = node.config.agentId;
    const agent = typeof agentId === 'string'
      ? await this.store.read((state) => {
          const run = state.runs.find((candidate) => candidate.id === runId);
          return run?.workflowDefinition.agents.find((candidate) => candidate.id === agentId);
        })
      : undefined;
    if (agent === undefined) {
      throw new Error('Agent loop references a missing agent definition.');
    }
    const maxIterations =
      typeof node.config.maxIterations === 'number'
        ? Math.min(node.config.maxIterations, agent.limits.maxIterations)
        : agent.limits.maxIterations;
    const checkpoint = await this.store.read((state) => state.runs.find((candidate) => candidate.id === runId)?.agentCheckpoints?.[node.id]);
    const firstIteration = checkpoint === undefined
      ? 1
      : Math.min(Math.max(1, checkpoint.nextIteration), maxIterations + 1);
    let lastModelOutput: string | undefined;
    for (let iteration = firstIteration; iteration <= maxIterations; iteration += 1) {
      signal.throwIfAborted();
      const goal = typeof node.config.goal === 'string' ? node.config.goal : 'Complete the task.';
      const invocation = await this.invokeModel(runId, traceId, node.id, agent, goal, signal);
      const modelResult = invocation?.result;
      const provider = invocation?.provider ?? agent.model.provider?.toLowerCase();
      if (modelResult !== undefined) {
        lastModelOutput = modelResult.content;
        const toolCalls = 'toolCalls' in modelResult && Array.isArray(modelResult.toolCalls)
          ? modelResult.toolCalls as Array<{ callId: string; name: string; arguments: string }>
          : [];
        if (toolCalls.length > 0) {
          for (const call of toolCalls) {
            const priorToolEvidence = await this.store.read((state) => state.evidence.find((evidence) =>
              evidence.runId === runId
              && evidence.unitId === node.id
              && evidence.operation === 'agent.tool'
              && evidence.idempotencyKey === `${call.callId}:succeeded`,
            ));
            if (priorToolEvidence !== undefined) {
              await this.events.emit(runId, 'agent.tool.recovered', `Agent tool ${call.name} was already completed; skipping duplicate side effect.`, {
                nodeId: node.id,
                signal: 'trace',
                spanKind: 'tool',
                attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': call.name, 'tool.call_id': call.callId, 'tool.recovered': true },
              });
              continue;
            }
            const pendingToolEvidence = await this.store.read((state) => state.evidence.find((evidence) =>
              evidence.runId === runId
              && evidence.unitId === node.id
              && evidence.operation === 'agent.tool'
              && evidence.idempotencyKey === `${call.callId}:started`,
            ));
            if (pendingToolEvidence !== undefined) {
              await this.events.emit(runId, 'agent.tool.incomplete', `Agent tool ${call.name} has an incomplete checkpoint; manual recovery is required.`, {
                nodeId: node.id,
                signal: 'log',
                spanKind: 'tool',
                severityText: 'ERROR',
                attributes: {
                  'openinference.span.kind': 'TOOL',
                  'tool.name': call.name,
                  'tool.call_id': call.callId,
                  'tool.checkpoint': 'incomplete',
                  ...this.sourceMetadata(node),
                },
              });
              throw new Error(`Agent tool "${call.name}" has an incomplete checkpoint; refusing to duplicate side effects.`);
            }
            const argumentsHash = createHash('sha256').update(call.arguments).digest('hex');
            await this.events.emit(runId, 'agent.tool.requested', `Agent requested tool ${call.name}.`, {
              nodeId: node.id,
              signal: 'trace',
              spanKind: 'tool',
              attributes: {
                'openinference.span.kind': 'TOOL',
                'tool.name': call.name,
                'tool.call_id': call.callId,
                'tool.arguments_hash': argumentsHash,
              },
            });
            if (!agent.tools.includes(call.name)) {
              await this.events.recordEvidence({ runId, unitId: node.id, operation: 'agent.tool', idempotencyKey: `${call.callId}:failed`, status: 'failed', error: `Agent requested undeclared tool "${call.name}".` });
              await this.events.emit(runId, 'agent.tool.rejected', `Agent requested undeclared tool ${call.name}.`, {
                nodeId: node.id,
                severityText: 'ERROR',
                attributes: { 'tool.name': call.name, 'tool.call_id': call.callId, 'tool.arguments_hash': argumentsHash },
              });
              throw new Error(`Agent "${agent.id}" requested undeclared tool "${call.name}".`);
            }
            const executor = this.toolExecutors.get(call.name);
            if (executor === undefined) {
              await this.events.recordEvidence({ runId, unitId: node.id, operation: 'agent.tool', idempotencyKey: `${call.callId}:failed`, status: 'failed', error: `No executor registered for declared tool "${call.name}".` });
              throw new Error(`No executor registered for declared tool "${call.name}".`);
            }
            let parsedArguments: unknown;
            try {
              parsedArguments = JSON.parse(call.arguments) as unknown;
            } catch {
              throw new Error(`Tool "${call.name}" returned invalid JSON arguments.`);
            }
            await this.events.recordEvidence({ runId, unitId: node.id, operation: 'agent.tool', idempotencyKey: `${call.callId}:started`, status: 'started', input: { name: call.name, callId: call.callId, argumentsHash } });
            const toolResult = await executor({ runId, nodeId: node.id, agentId: agent.id, callId: call.callId, name: call.name, arguments: parsedArguments, signal });
            await this.events.recordEvidence({ runId, unitId: node.id, operation: 'agent.tool', idempotencyKey: `${call.callId}:succeeded`, status: 'succeeded', output: { name: call.name, callId: call.callId, resultHash: createHash('sha256').update(JSON.stringify(toolResult) ?? 'undefined').digest('hex') } });
            await this.events.emit(runId, 'agent.tool.completed', `Agent tool ${call.name} completed.`, {
              nodeId: node.id,
              signal: 'trace',
              spanKind: 'tool',
              attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': call.name, 'tool.call_id': call.callId },
            });
          }
        }
      }
      await this.events.emit(
        runId,
        'agent.iteration',
        `Agent iteration ${iteration} of ${maxIterations}.`,
        {
          nodeId: node.id,
          signal: 'trace',
          spanKind: 'agent',
          attributes: {
            'openinference.span.kind': 'AGENT',
            'agent.id': agent.id,
            'agent.version': agent.version,
            'agent.iteration': iteration,
            'agent.max_iterations': maxIterations,
            'llm.model_name': modelResult?.model ?? agent.model.model ?? agent.model.routingAlias ?? 'unconfigured',
            ...(invocation === undefined ? {} : {
              'llm.route.index': invocation.routeIndex,
              'llm.route.strategy': invocation.routingStrategy,
              ...(invocation.adapterVersion === undefined ? {} : { 'llm.adapter.version': invocation.adapterVersion }),
            }),
          },
          ...(agent.observability.captureInputs
            ? { data: { iteration, goal } }
            : { data: { iteration } }),
        },
      );
      if (modelResult !== undefined) {
        await this.events.emit(runId, 'llm.completed', `${provider ?? 'Configured'} model completed.`, {
          nodeId: node.id,
          signal: 'trace',
          spanKind: 'llm',
          attributes: {
            'openinference.span.kind': 'LLM',
            'llm.model_name': modelResult.model,
            'llm.provider': provider ?? 'unknown',
            ...(invocation === undefined ? {} : {
              'llm.route.index': invocation.routeIndex,
              'llm.route.strategy': invocation.routingStrategy,
              ...(invocation.adapterVersion === undefined ? {} : { 'llm.adapter.version': invocation.adapterVersion }),
            }),
            ...(modelResult.requestId === undefined ? {} : { 'llm.request_id': modelResult.requestId }),
            ...(modelResult.promptTokens === undefined ? {} : { 'llm.token_count.prompt': modelResult.promptTokens }),
            ...(modelResult.completionTokens === undefined ? {} : { 'llm.token_count.completion': modelResult.completionTokens }),
            ...('latencyMs' in modelResult && typeof (modelResult as { latencyMs?: unknown }).latencyMs === 'number' ? { 'llm.latency_ms': (modelResult as { latencyMs: number }).latencyMs } : {}),
            ...('finishReason' in modelResult && typeof (modelResult as { finishReason?: unknown }).finishReason === 'string' ? { 'llm.finish_reason': (modelResult as { finishReason: string }).finishReason } : {}),
          },
          ...(agent.observability.captureOutputs ? { data: { output: modelResult.content } } : {}),
        });
      }
      const configuredModelCost = modelResult !== undefined && 'estimatedCostUsd' in modelResult && typeof (modelResult as { estimatedCostUsd?: unknown }).estimatedCostUsd === 'number'
        ? (modelResult as { estimatedCostUsd: number }).estimatedCostUsd
        : undefined;
      const iterationCost = configuredModelCost ?? (provider === 'ollama' ? 0 : 0.0015);
      const continued = await this.store.mutate((state) => {
        const run = state.runs.find((candidate) => candidate.id === runId);
        if (run === undefined || run.status === 'cancelled') {
          return false;
        }
        // Local inference has no provider charge; retain the preview charge for
        // unconfigured/simulated providers until their adapters are implemented.
        run.costUsd = Number((run.costUsd + iterationCost).toFixed(6));
        return true;
      });
      await this.events.emit(runId, 'agent.cost', 'Agent cost recorded.', {
        nodeId: node.id,
        signal: 'metric',
        spanKind: 'agent',
        attributes: {
          'metric.name': 'gen_ai.cost.usd',
          'metric.value': iterationCost,
          'agent.id': agent.id,
          'agent.version': agent.version,
        },
      });
      const outputHash = modelResult === undefined
        ? checkpoint?.outputHash
        : createHash('sha256').update(modelResult.content).digest('hex');
      await this.store.mutate((state) => {
        const run = state.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) return;
        run.agentCheckpoints ??= {};
        run.agentCheckpoints[node.id] = {
          nextIteration: iteration + 1,
          maxIterations,
          ...(outputHash === undefined ? {} : { outputHash }),
          updatedAt: new Date().toISOString(),
        };
      });
      await this.events.emit(runId, 'agent.checkpoint.saved', `Agent checkpoint saved after iteration ${iteration}.`, {
        nodeId: node.id,
        signal: 'trace',
        spanKind: 'agent',
        attributes: {
          'openinference.span.kind': 'AGENT',
          'agent.id': agent.id,
          'agent.version': agent.version,
          'agent.iteration': iteration,
          'agent.next_iteration': iteration + 1,
          'agent.max_iterations': maxIterations,
          ...(outputHash === undefined ? {} : { 'agent.output_hash': outputHash }),
        },
      });
      if (!continued) {
        signal.throwIfAborted();
        throw new Error('Run stopped during agent execution.');
      }
    }
    return {
      iterations: maxIterations,
      outcome: 'bounded-completion',
      ...(lastModelOutput === undefined ? {} : { output: lastModelOutput }),
    };
  }

  private async invokeModel(
    runId: string,
    traceId: string,
    nodeId: string,
    agent: AgentDefinition,
    goal: string,
    signal: AbortSignal,
  ): Promise<{ provider: string; result: OpenAIModelResult | OllamaModelResult; routeIndex: number; routingStrategy: 'single' | 'fallback' | 'ensemble'; adapterVersion?: string } | undefined> {
    const declaredRoutes = agent.model.routes ?? [];
    const routes: Array<AgentModelRoute | undefined> = declaredRoutes.length === 0
      ? [undefined]
      : declaredRoutes;
    const strategy = agent.model.routing?.strategy ?? (declaredRoutes.length > 1 ? 'fallback' : 'single');
    const maxAttempts = Math.min(routes.length, agent.model.routing?.maxAttempts ?? routes.length);
    const invokeRoute = async (index: number): Promise<{ provider: string; result: OpenAIModelResult | OllamaModelResult; adapterVersion?: string } | undefined> => {
      const route = routes[index];
      const routeAgent = route === undefined
        ? agent
        : (() => {
            const { routes: _routes, routing: _routing, ...baseModel } = agent.model;
            return { ...agent, model: { ...baseModel, ...route } };
          })();
      const provider = routeAgent.model.provider?.trim().toLowerCase();
      if (provider === undefined || provider === '') {
        if (declaredRoutes.length === 0) return undefined;
        throw new Error(`Agent "${agent.id}" provider route ${index + 1} is missing a provider.`);
      }
      const allowedConnections = agent.boundaries.allowedConnections.map((connection) => connection.trim().toLowerCase()).filter(Boolean);
      if (allowedConnections.length > 0 && !allowedConnections.includes(provider)) {
        await this.events.emit(runId, 'agent.connection.denied', `Agent ${agent.id} is not authorized to use the ${provider} connection.`, {
          nodeId,
          signal: 'log',
          severityText: 'WARN',
          attributes: {
            'agent.id': agent.id,
            'agent.version': agent.version,
            'connection.provider': provider,
            'connection.policy': 'allowedConnections',
          },
        });
        throw new Error(`Agent "${agent.id}" is not authorized to use the "${provider}" connection.`);
      }
      let result: OpenAIModelResult | OllamaModelResult;
      const registered = this.providerClients.get(provider);
      const requiredCapabilities = routeAgent.model.capabilities ?? [];
      if (requiredCapabilities.length > 0) {
        const supportedCapabilities = provider === 'ollama'
          ? ['text', 'usage']
          : registered?.capabilities ?? (provider === 'openai' ? this.openai?.capabilities : this.openaiCompatible?.capabilities) ?? [];
        const missing = requiredCapabilities.filter((capability) => !supportedCapabilities.includes(capability));
        if (missing.length > 0) throw new Error(`Provider "${provider}" does not support required capabilities: ${missing.join(', ')}.`);
      }
      if (registered !== undefined) {
        result = await registered.chat({ agent: routeAgent, goal, signal, traceId });
      } else if (provider === 'ollama') {
        result = await this.ollama.chat({ agent: routeAgent, goal, signal, traceId });
      } else if (provider === 'openai') {
        if (this.openai === undefined) throw new Error('OpenAI credentials are not configured for this runtime.');
        result = await this.openai.chat({ agent: routeAgent, goal, signal, traceId });
      } else if (provider === 'openai-compatible' || provider === 'lmstudio' || provider === 'lm-studio' || provider === 'vllm' || provider === 'localai') {
        if (this.openaiCompatible === undefined) throw new Error(`The ${provider} model adapter is not configured for this runtime.`);
        result = await this.openaiCompatible.chat({ agent: routeAgent, goal, signal, traceId });
      } else {
        throw new Error(`Unsupported model provider "${provider}".`);
      }
      return { provider, result, ...(routeAgent.model.adapterVersion === undefined ? {} : { adapterVersion: routeAgent.model.adapterVersion }) };
    };

    const emitRouteSelected = async (selected: { provider: string; index: number }): Promise<void> => {
      await this.events.emit(runId, 'llm.route.selected', `Model ${strategy} route ${selected.provider} selected.`, {
        nodeId,
        signal: 'trace',
        spanKind: 'llm',
        attributes: {
          'llm.route.provider': selected.provider,
          'llm.route.index': selected.index,
          'llm.route.strategy': strategy,
        },
      });
    };

    if (strategy === 'ensemble') {
      const structured = Object.keys(agent.outputSchema).length > 0;
      const results: Array<{ provider: string; result: OpenAIModelResult | OllamaModelResult; adapterVersion?: string; parsed?: unknown }> = [];
      let lastError: unknown;
      for (let index = 0; index < maxAttempts; index += 1) {
        try {
          const result = await invokeRoute(index);
          if (result === undefined) continue;
          if ('toolCalls' in result.result && Array.isArray(result.result.toolCalls) && result.result.toolCalls.length > 0) {
            throw new Error('Ensemble routing does not support tool calls because they could duplicate side effects.');
          }
          if (structured) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(result.result.content) as unknown;
            } catch {
              throw new Error(`Model ensemble route ${result.provider} returned invalid structured output.`);
            }
            results.push({ ...result, parsed });
          } else {
            results.push(result);
          }
          await emitRouteSelected({ provider: result.provider, index });
        } catch (error) {
          lastError = error;
          if (signal.aborted) throw error;
          const provider = routes[index]?.provider?.trim().toLowerCase() ?? 'unknown';
          await this.events.emit(runId, 'llm.route.failed', `Model ensemble route ${provider} failed; continuing.`, {
            nodeId,
            signal: 'trace',
            spanKind: 'llm',
            severityText: 'WARN',
            attributes: {
              'llm.route.provider': provider,
              'llm.route.index': index,
              'llm.route.strategy': strategy,
            },
          });
        }
      }
      if (results.length === 0) throw lastError instanceof Error ? lastError : new Error(`Agent "${agent.id}" did not produce an ensemble result.`);
      const first = results[0];
      if (first === undefined) throw new Error(`Agent "${agent.id}" did not produce an ensemble result.`);
      const sum = (selector: (result: OpenAIModelResult | OllamaModelResult) => number | undefined): number | undefined => {
        const values = results.map((entry) => selector(entry.result)).filter((value): value is number => value !== undefined);
        return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
      };
      let consensusCount: number | undefined;
      const aggregateContent = structured
        ? (() => {
            const candidates = results
              .filter((entry): entry is typeof entry & { parsed: unknown } => entry.parsed !== undefined)
              .map((entry, index) => ({ entry, index, key: stableValue(entry.parsed) }));
            const counts = new Map<string, { count: number; firstIndex: number; value: unknown }>();
            for (const candidate of candidates) {
              const existing = counts.get(candidate.key);
              counts.set(candidate.key, existing === undefined
                ? { count: 1, firstIndex: candidate.index, value: candidate.entry.parsed }
                : { ...existing, count: existing.count + 1 });
            }
            const winner = [...counts.values()].sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)[0];
            if (winner === undefined) throw new Error(`Agent "${agent.id}" did not produce valid structured ensemble output.`);
            consensusCount = winner.count;
            return JSON.stringify(winner.value);
          })()
        : results.map((entry) => `[${entry.provider}]\n${entry.result.content}`).join('\n\n');
      const aggregate: OpenAIModelResult | OllamaModelResult = {
        ...first.result,
        content: aggregateContent,
        model: results.map((entry) => entry.result.model).join(' + '),
        ...(sum((result) => result.promptTokens) === undefined ? {} : { promptTokens: sum((result) => result.promptTokens) }),
        ...(sum((result) => result.completionTokens) === undefined ? {} : { completionTokens: sum((result) => result.completionTokens) }),
        ...('estimatedCostUsd' in first.result && sum((result) => 'estimatedCostUsd' in result ? result.estimatedCostUsd : undefined) !== undefined
          ? { estimatedCostUsd: sum((result) => 'estimatedCostUsd' in result ? result.estimatedCostUsd : undefined) }
          : {}),
      };
      if (structured && consensusCount !== undefined) await this.events.emit(runId, 'llm.ensemble.consensus', `Structured ensemble reached a ${consensusCount}/${results.length} consensus.`, {
        nodeId,
        signal: 'metric',
        spanKind: 'llm',
        attributes: { 'llm.route.strategy': strategy, 'llm.ensemble.candidate_count': results.length, 'llm.ensemble.consensus_count': consensusCount },
      });
      return { provider: 'ensemble', result: aggregate, routeIndex: -1, routingStrategy: strategy };
    }

    for (let index = 0; index < maxAttempts; index += 1) {
      try {
        const result = await invokeRoute(index);
        if (result === undefined) return undefined;
        if (index > 0) await emitRouteSelected({ provider: result.provider, index });
        return { ...result, routeIndex: index, routingStrategy: strategy };
      } catch (error) {
        if (signal.aborted) throw error;
        if (strategy !== 'fallback' || index + 1 >= maxAttempts) throw error;
        const provider = routes[index]?.provider?.trim().toLowerCase() ?? 'unknown';
        await this.events.emit(runId, 'llm.route.failed', `Model route ${provider} failed; trying the next route.`, {
          nodeId,
          signal: 'trace',
          spanKind: 'llm',
          severityText: 'WARN',
          attributes: {
            'llm.route.provider': provider,
            'llm.route.index': index,
            'llm.route.strategy': strategy,
          },
        });
      }
    }
    throw new Error(`Agent "${agent.id}" did not produce a model result.`);
  }

  private async workspaceForRun(runId: string): Promise<RepositoryWorkspace> {
    if (this.repositoryWorkspace === undefined) {
      throw new Error('Repository workspace is not configured for this runtime.');
    }
    const existing = this.runWorkspaces.get(runId);
    if (existing !== undefined) return existing;
    const isolated = await this.repositoryWorkspace.cloneForRun(runId);
    this.runWorkspaces.set(runId, isolated);
    return isolated;
  }

  private operationMetadata(result: unknown): Record<string, string | number | boolean> | undefined {
    if (result === null || typeof result !== 'object') return undefined;
    const value = result as Record<string, unknown>;
    const metadata: Record<string, string | number | boolean> = {};
    if (typeof value.repository === 'string') metadata['repository.name'] = value.repository;
    for (const [key, outputKey] of [['id', 'operation.id'], ['baseRevision', 'repository.base_revision'], ['branch', 'repository.branch'], ['revision', 'repository.revision']] as const) {
      if (typeof value[key] === 'string') metadata[outputKey] = value[key];
    }
    if (typeof value.number === 'number') metadata['pull_request.number'] = value.number;
    if (typeof value.url === 'string') metadata['provider.url'] = value.url;
    if (typeof value.requestId === 'string') metadata['provider.request_id'] = value.requestId;
    if (typeof value.state === 'string') metadata['pull_request.state'] = value.state;
    if (typeof value.ref === 'string') metadata['ci.ref'] = value.ref;
    if (typeof value.status === 'string') metadata['ci.status'] = value.status;
    if (typeof value.exitCode === 'number') metadata['check.exit_code'] = value.exitCode;
    if (typeof value.timedOut === 'boolean') metadata['check.timed_out'] = value.timedOut;
    if (typeof value.cancelled === 'boolean') metadata['check.cancelled'] = value.cancelled;
    if (value.sandbox !== null && typeof value.sandbox === 'object') {
      const sandbox = value.sandbox as Record<string, unknown>;
      if (typeof sandbox.mode === 'string') metadata['check.sandbox.mode'] = sandbox.mode;
      if (typeof sandbox.network === 'string') metadata['check.sandbox.network'] = sandbox.network;
      if (typeof sandbox.image === 'string') metadata['check.sandbox.image'] = sandbox.image;
      if (typeof sandbox.memoryMb === 'number') metadata['check.sandbox.memory_mb'] = sandbox.memoryMb;
      if (typeof sandbox.cpus === 'number') metadata['check.sandbox.cpus'] = sandbox.cpus;
      if (typeof sandbox.pidsLimit === 'number') metadata['check.sandbox.pids_limit'] = sandbox.pidsLimit;
    }
    if (typeof value.transactionId === 'string') metadata['operation.transaction_id'] = value.transactionId;
    if (typeof value.rolledBack === 'boolean') metadata['mutation.rolled_back'] = value.rolledBack;
    if (typeof value.expected === 'string') metadata['repository.expected'] = value.expected;
    if (typeof value.actual === 'string') metadata['repository.actual'] = value.actual;
    if (typeof value.policy === 'string') metadata['repository.policy'] = value.policy;
    if (typeof value.value === 'string') metadata['repository.policy_value'] = value.value;
    if (Array.isArray(value.required)) metadata['ci.required_count'] = value.required.length;
    if (Array.isArray(value.failures)) metadata['ci.failure_count'] = value.failures.length;
    if (Array.isArray(value.failures)) {
      value.failures.slice(0, 10).forEach((failure, index) => {
        if (failure === null || typeof failure !== 'object') return;
        const entry = failure as Record<string, unknown>;
        if (typeof entry.name === 'string') metadata[`ci.failure.${index}.name`] = entry.name;
        if (typeof entry.conclusion === 'string') metadata[`ci.failure.${index}.conclusion`] = entry.conclusion;
        if (typeof entry.url === 'string') metadata[`ci.failure.${index}.url`] = entry.url;
      });
    }
    const patch = value.patch;
    if (patch !== null && typeof patch === 'object') {
      const patchValue = patch as Record<string, unknown>;
      if (typeof patchValue.id === 'string') metadata['patch.artifact_id'] = patchValue.id;
      if (Array.isArray(patchValue.changedPaths)) metadata['patch.changed_path_count'] = patchValue.changedPaths.length;
    }
    const artifactRef = value.artifactRef;
    if (artifactRef !== null && typeof artifactRef === 'object' && typeof (artifactRef as { id?: unknown }).id === 'string') {
      metadata['artifact.payload_id'] = (artifactRef as { id: string }).id;
    }
    return Object.keys(metadata).length === 0 ? undefined : metadata;
  }

  private sourceMetadata(node: WorkflowNode): Record<string, string | number | boolean> {
    return {
      ...(node.sourcePath === undefined ? {} : { 'source.path': node.sourcePath }),
      ...(node.sourceLine === undefined ? {} : { 'source.line': node.sourceLine }),
    };
  }

  private requiresApproval(node: WorkflowNode, workflow?: WorkflowDefinition): boolean {
    if (node.type === 'approval' || node.config.requiresApproval === true) return true;
    if (node.type !== 'agentLoop' || workflow === undefined) return false;
    const agentId = typeof node.config.agentId === 'string' ? node.config.agentId : undefined;
    const agent = agentId === undefined ? undefined : workflow.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) return false;
    // A tool-capable agent may cause side effects even when the model has not
    // requested one yet; gate the whole invocation so policy cannot be bypassed.
    return agent.approval.beforeSideEffects && agent.tools.length > 0 || agent.approval.beforeTools.length > 0;
  }

  private approvalFingerprint(run: RunRecord, node: WorkflowNode): string {
    const inputs = run.workflowDefinition.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => run.unitOutputs[edge.source]);
    return createHash('sha256').update(JSON.stringify({
      artifactId: run.artifactId,
      nodeId: node.id,
      nodeType: node.type,
      config: node.config,
      inputs,
    })).digest('hex');
  }

  private async completeNode(
    runId: string,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    result: unknown,
    persistedResult: unknown = result,
  ): Promise<boolean> {
    const completed = await this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        throw new Error('Run not found while completing node.');
      }
      if (run.status === 'cancelled') {
        return false;
      }
      if (!run.completedNodeIds.includes(node.id)) {
        run.completedNodeIds.push(node.id);
      }
      run.unitOutputs[node.id] = persistedResult;
      delete run.agentCheckpoints?.[node.id];
      delete run.ciCheckpoints[node.id];
      for (const edge of workflow.edges.filter(
        (candidate) =>
          candidate.source === node.id && edgeMatches(candidate, result),
      )) {
        if (!run.activatedNodeIds.includes(edge.target)) {
          run.activatedNodeIds.push(edge.target);
        }
      }
      return true;
    });
    if (!completed) {
      return false;
    }
    const agentDefinition = node.type === 'agentLoop' && typeof node.config.agentId === 'string'
      ? workflow.agents.find((candidate) => candidate.id === node.config.agentId)
      : undefined;
    await this.events.emit(runId, 'node.completed', `${node.label} completed.`, {
      nodeId: node.id,
      ...(agentDefinition?.observability.captureOutputs || agentDefinition === undefined
        ? { data: { result: persistedResult } }
        : { data: { result: '[redacted]' } }),
    });
    return true;
  }

  private async transitionToRunning(runId: string): Promise<boolean> {
    return this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        throw new Error('Run not found.');
      }
      if (!['queued', 'running'].includes(run.status)) {
        return false;
      }
      run.status = 'running';
      return true;
    });
  }

  private async waitForApproval(runId: string, nodeId: string): Promise<void> {
    let approvalId: string | undefined;
    const waiting = await this.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        throw new Error('Run not found.');
      }
      if (run.status === 'cancelled') {
        return false;
      }
      run.status = 'waiting';
      const node = run.workflowDefinition.nodes.find((candidate) => candidate.id === nodeId);
      if (node !== undefined) {
        const bindingHash = this.approvalFingerprint(run, node);
        run.pendingApprovalHashes[nodeId] = bindingHash;
        let approval = state.approvals.find((candidate) => candidate.runId === runId && candidate.nodeId === nodeId && candidate.decision === 'pending');
        if (approval === undefined || approval.bindingHash !== bindingHash) {
          if (approval !== undefined) {
            approval.decision = 'superseded';
            approval.decidedAt = new Date().toISOString();
          }
          const requestedAt = new Date();
          approval = {
            id: `approval-${randomUUID()}`,
            ...(run.tenantId === undefined ? {} : { tenantId: run.tenantId }),
            ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
            runId,
            nodeId,
            operation: node.type,
            bindingHash,
            decision: 'pending',
            requestedAt: requestedAt.toISOString(),
            expiresAt: new Date(requestedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
          } satisfies ApprovalRecord;
          state.approvals.unshift(approval);
        }
        approvalId = approval.id;
      }
      return true;
    });
    if (!waiting) {
      return;
    }
    await this.events.emit(
      runId,
      'approval.requested',
      'Workflow is waiting for human approval.',
      { nodeId },
    );
    await this.events.recordEvidence({ runId, unitId: nodeId, operation: 'approval', status: 'waiting', idempotencyKey: approvalId, metadata: approvalId === undefined ? undefined : { 'approval.id': approvalId } });
  }

  private async completeRun(runId: string): Promise<void> {
    const completedAt = new Date();
    await this.events.mutateAndEmit(runId, 'run.succeeded', 'Workflow run succeeded.', (state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        throw new Error('Run not found.');
      }
      if (run.status === 'cancelled' || run.status === 'paused') {
        return { value: false, emit: false };
      }
      run.status = 'succeeded';
      run.completedAt = completedAt.toISOString();
      run.durationMs =
        completedAt.getTime() - new Date(run.startedAt).getTime();
      run.ciCheckpoints = {};
      return { value: true };
    });
  }

  private async failRun(runId: string, message: string, status: 'failed' | 'timed_out' = 'failed'): Promise<void> {
    const completedAt = new Date();
    await this.events.mutateAndEmit(runId, status === 'timed_out' ? 'run.timed_out' : 'run.failed', message, (state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.status === 'cancelled') {
        return { value: false, emit: false };
      }
      run.status = status;
      run.error = message;
      run.completedAt = completedAt.toISOString();
      run.durationMs =
        completedAt.getTime() - new Date(run.startedAt).getTime();
      return { value: true };
    });
  }
}
