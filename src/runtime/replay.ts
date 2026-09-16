import { createHash, randomUUID } from 'node:crypto';

import type { ReplayReportRecord, RunRecord, WorkflowDefinition } from '../domain/types.js';
import type { PlatformStore } from '../storage/store.js';
import type { LocalWorkflowExecutor } from './executor.js';

export type { ReplayReportStatus } from '../domain/types.js';
export type ReplayReport = ReplayReportRecord;

export class ReplayNotDeterministicError extends Error {
  public constructor(nodeTypes: string[]) {
    super(`Replay requires deterministic nodes; found: ${nodeTypes.join(', ')}.`);
    this.name = 'ReplayNotDeterministicError';
  }
}

const deterministicNodeTypes = new Set(['manualTrigger', 'transform', 'output', 'code', 'condition']);

/** Replays a pinned run definition and compares only safe structural outputs. */
export class WorkflowReplayService {
  public constructor(private readonly store: PlatformStore, private readonly executor: LocalWorkflowExecutor) {}

  public async replay(sourceRunId: string, options: { timeoutMs?: number } = {}): Promise<ReplayReport> {
    const source = await this.store.read((state) => state.runs.find((run) => run.id === sourceRunId));
    if (source === undefined) throw new Error('Source run not found.');
    const nondeterministic = source.workflowDefinition.nodes
      .map((node) => node.type)
      .filter((type) => !deterministicNodeTypes.has(type));
    if (nondeterministic.length > 0) throw new ReplayNotDeterministicError([...new Set(nondeterministic)]);

    const startedAt = Date.now();
    const replay = await this.executor.start(source.workflowDefinition, {
      ...(source.artifactId === undefined ? {} : { artifactId: source.artifactId }),
      replayOfRunId: source.id,
    });
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 120_000);
    const result = await this.waitForTerminal(replay.id, timeoutMs);
    if (result === undefined) {
      return this.report(source, replay, 'timed_out', ['Replay did not reach a terminal state before the timeout.'], startedAt);
    }
    if (result.status !== source.status) {
      return this.report(source, result, result.status === 'failed' ? 'failed' : 'mismatch', [`status: expected ${source.status}, received ${result.status}`], startedAt);
    }
    const differences = compareRuns(source, result);
    return this.report(source, result, differences.length === 0 ? 'passed' : 'mismatch', differences, startedAt);
  }

  private async waitForTerminal(runId: string, timeoutMs: number): Promise<RunRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.store.read((state) => state.runs.find((candidate) => candidate.id === runId));
      if (run !== undefined && ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  private async report(source: RunRecord, replay: RunRecord, status: ReplayReport['status'], differences: string[], startedAt: number): Promise<ReplayReport> {
    const report: ReplayReport = {
      id: `replay-report-${randomUUID()}`,
      ...(source.tenantId === undefined ? {} : { tenantId: source.tenantId }),
      ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
      sourceRunId: source.id,
      replayRunId: replay.id,
      workflowId: source.workflowId,
      workflowVersion: source.workflowVersion,
      status,
      differences,
      completedNodeIds: replay.completedNodeIds,
      durationMs: Date.now() - startedAt,
      sourceOutputHash: outputHash(source),
      ...(replay.status === 'succeeded' || replay.status === 'failed' || replay.status === 'timed_out' || replay.status === 'cancelled'
        ? { replayOutputHash: outputHash(replay) }
        : {}),
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate((state) => {
      state.replayReports.unshift(report);
    });
    return report;
  }
}

function compareRuns(source: RunRecord, replay: RunRecord): string[] {
  const differences: string[] = [];
  if (JSON.stringify(source.completedNodeIds) !== JSON.stringify(replay.completedNodeIds)) differences.push('completedNodeIds differ.');
  const nodeIds = new Set([...Object.keys(source.unitOutputs), ...Object.keys(replay.unitOutputs)]);
  for (const nodeId of nodeIds) {
    if (stableSerialize(source.unitOutputs[nodeId]) !== stableSerialize(replay.unitOutputs[nodeId])) differences.push(`unitOutputs.${nodeId} differs.`);
  }
  return differences;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function outputHash(run: RunRecord): string {
  return createHash('sha256').update(stableSerialize(run.unitOutputs)).digest('hex');
}

export function isReplayableWorkflow(workflow: WorkflowDefinition): boolean {
  return workflow.nodes.every((node) => deterministicNodeTypes.has(node.type));
}
