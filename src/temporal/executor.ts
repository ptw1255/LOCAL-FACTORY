import { Client, Connection } from '@temporalio/client';

import type { RunRecord, WorkflowDefinition } from '../domain/types.js';
import type { TemporalWorkflowResult } from './workflows.js';
import { createQueuedRun, releaseBundleHash, type RunCreationOptions } from '../runtime/executor.js';
import type { PlatformStore } from '../storage/store.js';
import type { EventService } from '../observability/event-service.js';

/** Minimal handle surface used by the control plane and easy to fake in tests. */
export interface TemporalWorkflowHandleLike {
  readonly workflowId: string;
  readonly firstExecutionRunId?: string;
  result(): Promise<TemporalWorkflowResult>;
  cancel(): Promise<unknown>;
  signal(signal: string, ...args: unknown[]): Promise<unknown>;
}

export interface TemporalWorkflowClientLike {
  workflow: {
    start(workflowType: string, options: {
      workflowId: string;
      taskQueue: string;
      args: unknown[];
      searchAttributes: Record<string, string[]>;
      memo: Record<string, unknown>;
    }): Promise<TemporalWorkflowHandleLike>;
    getHandle(workflowId: string, runId?: string): TemporalWorkflowHandleLike;
  };
}

export interface TemporalExecutorOptions {
  store: PlatformStore;
  events: EventService;
  client: TemporalWorkflowClientLike;
  taskQueuePrefix?: string;
}

/**
 * Temporal-backed execution plane. The local executor remains the default;
 * this adapter is selected explicitly by `EXECUTION_ENGINE=temporal`.
 */
export class TemporalWorkflowExecutor {
  private readonly handles = new Map<string, TemporalWorkflowHandleLike>();
  private readonly taskQueuePrefix: string;

  public constructor(private readonly options: TemporalExecutorOptions) {
    this.taskQueuePrefix = options.taskQueuePrefix?.trim() || 'agentic-workflows';
  }

  public static async connect(options: Omit<TemporalExecutorOptions, 'client'> & {
    address?: string;
    namespace?: string;
    taskQueuePrefix?: string;
  }): Promise<{ executor: TemporalWorkflowExecutor; close: () => Promise<void> }> {
    const connection = await Connection.connect({ address: options.address ?? process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
    const client = new Client({ connection, namespace: options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? 'default' });
    const executor = new TemporalWorkflowExecutor({ ...options, client: client as unknown as TemporalWorkflowClientLike });
    return { executor, close: () => connection.close() };
  }

  public async start(workflow: WorkflowDefinition, options: RunCreationOptions = {}): Promise<RunRecord> {
    const taskQueue = `${this.taskQueuePrefix}-v${workflow.version}`;
    const run = createQueuedRun(workflow, {
      ...options,
      executionEngine: 'temporal',
      temporalTaskQueue: taskQueue,
    });
    // Replace the generated identifier with the persisted run ID so retries and
    // recovery always address one stable Temporal execution.
    run.temporalWorkflowId = `factory-${run.id}`;
    await this.options.store.mutate((state) => { state.runs.unshift(run); });
    await this.options.events.emit(run.id, 'run.queued', 'Workflow run queued in Temporal.', {
      attributes: { 'runtime.engine': 'temporal', 'temporal.task_queue': taskQueue, 'workflow.version': workflow.version, ...(run.releaseBundleHash === undefined ? {} : { 'release.bundle.hash': run.releaseBundleHash }) },
    });
    try {
      const handle = await this.options.client.workflow.start('executeWorkflow', {
        workflowId: run.temporalWorkflowId,
        taskQueue,
        args: [{ runId: run.id, definition: run.workflowDefinition, releaseBundleHash: run.releaseBundleHash, pinnedAgentVersions: run.pinnedAgentVersions, ...(run.input === undefined ? {} : { input: run.input }) }],
        searchAttributes: {
          FactoryId: ['agentic-workflow-factory'],
          WorkflowId: [workflow.id],
          WorkflowVersion: [String(workflow.version)],
          Environment: [run.environment ?? workflow.status],
          Status: ['running'],
          CorrelationId: [run.traceId],
          ReleaseBundle: [run.releaseBundleHash ?? releaseBundleHash(workflow)],
          AgentVersions: [JSON.stringify(run.pinnedAgentVersions ?? {})],
        },
        memo: { artifactId: run.artifactId ?? '', workflowVersion: workflow.version, environment: run.environment ?? 'local', deploymentId: run.deploymentId ?? '', releaseBundleHash: run.releaseBundleHash ?? releaseBundleHash(workflow), pinnedAgentVersions: run.pinnedAgentVersions ?? {} },
      });
      this.handles.set(run.id, handle);
      await this.options.store.mutate((state) => {
        const target = state.runs.find((candidate) => candidate.id === run.id);
        if (target !== undefined) {
          target.status = 'running';
          target.temporalRunId = handle.firstExecutionRunId;
        }
      });
      await this.options.events.emit(run.id, 'run.started', 'Temporal workflow accepted.', {
        attributes: { 'runtime.engine': 'temporal', 'temporal.workflow_id': run.temporalWorkflowId },
      });
      void this.observe(run.id, handle);
      return (await this.options.store.read((state) => state.runs.find((candidate) => candidate.id === run.id))) ?? run;
    } catch (error) {
      await this.markFailed(run.id, error instanceof Error ? error.message : 'Temporal workflow could not be started.');
      throw error;
    }
  }

  /** Start a fresh Temporal execution from a terminal failure while preserving provenance. */
  public async retry(runId: string, options: { idempotencyKey?: string } = {}): Promise<RunRecord> {
    const source = await this.options.store.read((state) => state.runs.find((candidate) => candidate.id === runId));
    if (source === undefined) throw new Error('Run not found.');
    if (!['failed', 'timed_out', 'cancelled'].includes(source.status)) {
      throw new Error('Only failed, timed-out, or cancelled runs can be retried.');
    }
    const idempotencyKey = options.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== '') {
      const existing = await this.options.store.read((state) => state.runs.find((candidate) => candidate.retryIdempotencyKey === idempotencyKey));
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
    await this.options.events.emit(source.id, 'run.retried', `Run retried as ${retry.id}.`, { attributes: { 'run.retry_id': retry.id, 'runtime.engine': 'temporal' } });
    return retry;
  }

  public async recover(): Promise<number> {
    const runs = await this.options.store.read((state) => state.runs.filter((run) => run.executionEngine === 'temporal' && ['queued', 'running', 'paused'].includes(run.status)));
    for (const run of runs) {
      if (run.temporalWorkflowId === undefined) {
        await this.markFailed(run.id, 'Temporal run is missing its workflow identity.');
        continue;
      }
      const handle = this.options.client.workflow.getHandle(run.temporalWorkflowId, run.temporalRunId);
      this.handles.set(run.id, handle);
      await this.options.events.emit(run.id, 'run.recovered', 'Reattached to persisted Temporal workflow.', {
        attributes: { 'runtime.engine': 'temporal', 'temporal.workflow_id': run.temporalWorkflowId },
      });
      void this.observe(run.id, handle);
    }
    return runs.length;
  }

  public async approve(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    const handle = this.handleFor(run);
    const node = run.workflowDefinition.nodes.find((candidate) => (candidate.type === 'approval' || candidate.config.requiresApproval === true) && !run.completedNodeIds.includes(candidate.id));
    if (node === undefined) throw new Error('No approval-gated node is waiting.');
    if (run.approvedNodeIds.includes(node.id)) return run;
    await handle.signal('approve', node.id);
    return this.updateRun(runId, (target) => {
      target.status = 'running';
      if (!target.approvedNodeIds.includes(node.id)) target.approvedNodeIds.push(node.id);
    }, 'approval.received', 'Human approval received.');
  }

  /** Request a cooperative pause; the Temporal workflow keeps its checkpoint and waits. */
  public async pause(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (!['queued', 'running'].includes(run.status)) throw new Error('Only queued or running runs can be paused.');
    await this.handleFor(run).signal('pause');
    return this.updateRun(runId, (target) => {
      if (isTerminalRunStatus(target.status)) return false;
      target.status = 'paused';
    }, 'run.paused', 'Temporal workflow paused at a safe WorkUnit boundary.');
  }

  /** Resume a paused Temporal workflow from its durable checkpoint. */
  public async resume(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    if (run.status !== 'paused') throw new Error('Only paused runs can be resumed.');
    await this.handleFor(run).signal('resume');
    return this.updateRun(runId, (target) => {
      if (isTerminalRunStatus(target.status)) return false;
      target.status = 'running';
    }, 'run.resumed', 'Temporal workflow resumed from its persisted checkpoint.');
  }

  public async cancel(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    await this.handleFor(run).cancel();
    return this.updateRun(runId, (target) => {
      target.status = 'cancelled';
      target.completedAt = new Date().toISOString();
      target.durationMs = Date.now() - Date.parse(target.startedAt);
    }, 'run.cancelled', 'Temporal workflow cancelled.');
  }

  public async deny(runId: string, options: { reason?: string } = {}): Promise<RunRecord> {
    const run = await this.requireRun(runId);
    // Stop the durable execution, but persist one coherent operator decision.
    // Calling cancel() here would emit run.cancelled before denial is recorded.
    await this.handleFor(run).cancel();
    const reason = options.reason?.trim() || 'Workflow approval was denied.';
    return this.updateRun(runId, (target) => {
      target.status = 'failed';
      target.error = reason;
      target.completedAt = new Date().toISOString();
      target.durationMs = Date.now() - Date.parse(target.startedAt);
    }, 'run.failed', reason);
  }

  public async expire(runId: string, options: { reason?: string } = {}): Promise<RunRecord> {
    return this.deny(runId, { reason: options.reason?.trim() || 'Approval expired before it was received.' });
  }

  public async supersede(runId: string, options: { reason?: string } = {}): Promise<RunRecord> {
    return this.deny(runId, { reason: options.reason?.trim() || 'Approval superseded by operator.' });
  }

  private async observe(runId: string, handle: TemporalWorkflowHandleLike): Promise<void> {
    try {
      const result = await handle.result();
      await this.updateRun(runId, (run) => {
        if (['cancelled', 'failed'].includes(run.status)) return false;
        run.status = 'succeeded';
        run.completedNodeIds = [...result.completedNodeIds];
        run.unitOutputs = { ...result.unitOutputs };
        run.completedAt = new Date().toISOString();
        run.durationMs = Date.now() - Date.parse(run.startedAt);
      }, 'run.succeeded', 'Temporal workflow succeeded.');
    } catch (error) {
      await this.markFailed(runId, error instanceof Error ? error.message : 'Temporal workflow failed.');
    } finally {
      this.handles.delete(runId);
    }
  }

  private async markFailed(runId: string, message: string): Promise<void> {
    await this.updateRun(runId, (run) => {
      if (['succeeded', 'cancelled'].includes(run.status)) return false;
      run.status = 'failed';
      run.error = message.slice(0, 2_000);
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - Date.parse(run.startedAt);
      return true;
    }, 'run.failed', message);
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.options.store.read((state) => state.runs.find((candidate) => candidate.id === runId));
    if (run === undefined) throw new Error('Run not found.');
    if (run.executionEngine !== 'temporal') throw new Error('Run is owned by the local execution engine.');
    return run;
  }

  private handleFor(run: RunRecord): TemporalWorkflowHandleLike {
    if (run.temporalWorkflowId === undefined) throw new Error('Temporal run is missing its workflow identity.');
    const existing = this.handles.get(run.id);
    if (existing !== undefined) return existing;
    const handle = this.options.client.workflow.getHandle(run.temporalWorkflowId, run.temporalRunId);
    this.handles.set(run.id, handle);
    return handle;
  }

  private async updateRun(runId: string, mutation: (run: RunRecord) => boolean | void, eventType?: string, message?: string): Promise<RunRecord> {
    if (eventType !== undefined) {
      return this.options.events.mutateAndEmit(runId, eventType, message ?? eventType, (state) => {
        const run = state.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) throw new Error('Run not found.');
        return { value: run, emit: mutation(run) !== false };
      }, { attributes: { 'runtime.engine': 'temporal' } });
    }
    return this.options.store.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) throw new Error('Run not found.');
      mutation(run);
      return run;
    });
  }
}

function isTerminalRunStatus(status: RunRecord['status']): boolean {
  return ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(status);
}
