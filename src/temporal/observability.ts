import { createHash } from 'node:crypto';

import type { AgentSpanKind, OperationEvidence, RunEvent } from '../domain/types.js';
import type { PlatformStore } from '../storage/store.js';
import { telemetryAttributes, telemetryResource } from '../observability/semconv.js';

export type TemporalLifecycleStatus = 'started' | 'succeeded' | 'failed';

/** Serializable lifecycle data emitted by a Temporal activity attempt. */
export interface TemporalActivityLifecycle {
  runId: string;
  workflowId?: string;
  workflowVersion?: number;
  releaseBundleHash?: string;
  pinnedAgentVersions?: Record<string, number>;
  tenantId?: string;
  projectId?: string;
  nodeId: string;
  nodeType: string;
  agentId?: string;
  agentVersion?: number;
  unitKind: string;
  unitVersion: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sequence: number;
  attempt: number;
  idempotencyKey: string;
  status: TemporalLifecycleStatus;
  occurredAt: string;
  durationMs?: number;
  inputHash?: string;
  outputHash?: string;
  error?: string;
}

export interface TemporalObservabilitySink {
  record(lifecycle: TemporalActivityLifecycle): Promise<void> | void;
}

/**
 * Persists Temporal activity lifecycle records through the platform's normal
 * evidence and observability tables. IDs are deterministic so Temporal retries
 * cannot duplicate a lifecycle record.
 */
export class PlatformTemporalObservabilitySink implements TemporalObservabilitySink {
  public constructor(private readonly store: PlatformStore) {}

  public async record(lifecycle: TemporalActivityLifecycle): Promise<void> {
    // Keep duplicate delivery of one Temporal attempt idempotent while
    // retaining separate evidence for later retry attempts.
    const identity = `${lifecycle.idempotencyKey}:${lifecycle.status}:attempt:${lifecycle.attempt}`;
    const evidence: OperationEvidence = {
      id: deterministicUuid(`temporal:evidence:${identity}`),
      ...(lifecycle.tenantId === undefined ? {} : { tenantId: lifecycle.tenantId }),
      ...(lifecycle.projectId === undefined ? {} : { projectId: lifecycle.projectId }),
      runId: lifecycle.runId,
      unitId: lifecycle.nodeId,
      operation: lifecycle.nodeType,
      idempotencyKey: lifecycle.idempotencyKey,
      actor: 'temporal-worker',
      source: 'temporal-activity',
      correlationId: lifecycle.traceId,
      attempt: lifecycle.attempt,
      status: lifecycle.status,
      occurredAt: lifecycle.occurredAt,
      ...(lifecycle.inputHash === undefined ? {} : { inputHash: lifecycle.inputHash }),
      ...(lifecycle.outputHash === undefined ? {} : { outputHash: lifecycle.outputHash }),
      ...(lifecycle.error === undefined ? {} : { error: lifecycle.error.slice(0, 2_000) }),
      metadata: {
        ...(lifecycle.workflowId === undefined ? {} : { 'workflow.id': lifecycle.workflowId }),
        ...(lifecycle.workflowVersion === undefined ? {} : { 'workflow.version': lifecycle.workflowVersion }),
        ...(lifecycle.releaseBundleHash === undefined ? {} : { 'release.bundle.hash': lifecycle.releaseBundleHash }),
        ...(lifecycle.pinnedAgentVersions === undefined ? {} : { 'agent.versions': JSON.stringify(lifecycle.pinnedAgentVersions) }),
        ...(lifecycle.agentId === undefined ? {} : { 'agent.id': lifecycle.agentId }),
        ...(lifecycle.agentVersion === undefined ? {} : { 'agent.version': lifecycle.agentVersion }),
        'work.unit.kind': lifecycle.unitKind,
        'work.unit.version': lifecycle.unitVersion,
        ...(lifecycle.durationMs === undefined ? {} : { 'work.unit.duration_ms': lifecycle.durationMs }),
      },
    };
    await this.store.appendEvidence(evidence);

    const event: RunEvent = {
      ...(lifecycle.tenantId === undefined ? {} : { tenantId: lifecycle.tenantId }),
      ...(lifecycle.projectId === undefined ? {} : { projectId: lifecycle.projectId }),
      id: deterministicUuid(`temporal:event:${identity}`),
      runId: lifecycle.runId,
      nodeId: lifecycle.nodeId,
      type: `unit.${lifecycle.status}`,
      timestamp: lifecycle.occurredAt,
      message: `Temporal ${lifecycle.nodeType} unit ${lifecycle.status}.`,
      signal: 'trace',
      traceId: lifecycle.traceId,
      spanId: lifecycle.spanId,
      ...(lifecycle.parentSpanId === undefined ? {} : { parentSpanId: lifecycle.parentSpanId }),
      spanKind: temporalSpanKind(lifecycle.unitKind),
      severityText: lifecycle.status === 'failed' ? 'ERROR' : 'INFO',
      attributes: {
        ...telemetryResource,
        [telemetryAttributes.runId]: lifecycle.runId,
        [telemetryAttributes.traceId]: lifecycle.traceId,
        [telemetryAttributes.spanId]: lifecycle.spanId,
        [telemetryAttributes.unitId]: lifecycle.nodeId,
        ...(lifecycle.workflowId === undefined ? {} : { 'workflow.id': lifecycle.workflowId }),
        ...(lifecycle.workflowVersion === undefined ? {} : { 'workflow.version': lifecycle.workflowVersion }),
        ...(lifecycle.releaseBundleHash === undefined ? {} : { 'release.bundle.hash': lifecycle.releaseBundleHash }),
        ...(lifecycle.pinnedAgentVersions === undefined ? {} : { 'agent.versions': JSON.stringify(lifecycle.pinnedAgentVersions) }),
        ...(lifecycle.agentId === undefined ? {} : { 'agent.id': lifecycle.agentId }),
        ...(lifecycle.agentVersion === undefined ? {} : { 'agent.version': lifecycle.agentVersion }),
        'runtime.engine': 'temporal',
        'work.unit.kind': lifecycle.unitKind,
        'work.unit.version': lifecycle.unitVersion,
        'work.unit.sequence': lifecycle.sequence,
        'work.unit.attempt': lifecycle.attempt,
        ...(lifecycle.durationMs === undefined ? {} : { 'work.unit.duration_ms': lifecycle.durationMs }),
      },
      ...(lifecycle.error === undefined ? {} : { data: { error: lifecycle.error.slice(0, 2_000) } }),
    };
    await this.store.appendEvent(event);
  }
}

function temporalSpanKind(unitKind: string): AgentSpanKind {
  return unitKind === 'agent' ? 'agent' : unitKind === 'connector' || unitKind === 'consumer' ? 'tool' : 'chain';
}

function deterministicUuid(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
