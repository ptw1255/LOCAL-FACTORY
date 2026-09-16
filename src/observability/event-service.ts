import { createHash, randomUUID } from 'node:crypto';

import type { AgentSpanKind, EvidenceQuery, OperationEvidence, OperationEvidenceStatus, RunEvent } from '../domain/types.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { PlatformStore } from '../storage/store.js';
import type { TelemetryExporter } from './otlp-exporter.js';
import { telemetryAttributes, telemetryResource } from './semconv.js';

export class EventService {
  private readonly retentionHours: number;
  private readonly evidenceRetentionHours: number | undefined;
  private readonly artifactStore: ArtifactStore | undefined;
  private readonly inlineDataBytes: number;

  public constructor(
    private readonly store: PlatformStore,
    options: { retentionHours?: number; evidenceRetentionHours?: number; exporter?: TelemetryExporter; artifactStore?: ArtifactStore; inlineDataBytes?: number } = {},
  ) {
    this.retentionHours = options.retentionHours ?? 48;
    this.evidenceRetentionHours = options.evidenceRetentionHours;
    this.artifactStore = options.artifactStore;
    this.inlineDataBytes = Math.max(1_024, options.inlineDataBytes ?? 64 * 1_024);
    this.exporter = options.exporter;
  }

  private readonly exporter: TelemetryExporter | undefined;

  public async emit(
    runId: string,
    type: string,
    message: string,
    options: {
      nodeId?: string;
      tenantId?: string;
      projectId?: string;
      traceId?: string;
      data?: Record<string, unknown>;
      signal?: 'log' | 'trace' | 'metric';
      spanKind?: AgentSpanKind;
      parentSpanId?: string;
      severityText?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
      attributes?: Record<string, string | number | boolean>;
    } = {},
  ): Promise<RunEvent> {
    const runContext = await this.store.read((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      return {
        traceId: run?.traceId,
        tenantId: run?.tenantId,
        projectId: run?.projectId,
      };
    });
    const traceId = options.traceId ?? runContext.traceId ?? runId.replaceAll('-', '').padEnd(32, '0').slice(0, 32);
    const spanId = randomUUID().replaceAll('-', '').slice(0, 16);
    const data = options.data === undefined
      ? undefined
      : await this.offloadPayload(runId, options.data, `event:${type}`);
    const event: RunEvent = {
      ...((options.tenantId ?? runContext.tenantId) === undefined ? {} : { tenantId: options.tenantId ?? runContext.tenantId }),
      ...((options.projectId ?? runContext.projectId) === undefined ? {} : { projectId: options.projectId ?? runContext.projectId }),
      id: randomUUID(),
      runId,
      type,
      timestamp: new Date().toISOString(),
      message,
      signal: options.signal ?? 'log',
      traceId,
      spanId,
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      ...(data === undefined ? {} : { data: data as Record<string, unknown> }),
      ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
      ...(options.spanKind === undefined ? {} : { spanKind: options.spanKind }),
      ...(options.severityText === undefined ? {} : { severityText: options.severityText }),
      attributes: {
        ...telemetryResource,
        ...((options.tenantId ?? runContext.tenantId) === undefined ? {} : { 'tenant.id': options.tenantId ?? runContext.tenantId }),
        ...((options.projectId ?? runContext.projectId) === undefined ? {} : { 'project.id': options.projectId ?? runContext.projectId }),
        ...(options.attributes ?? {}),
        // Keep the correlation keys present on every signal. These are emitted as
        // OTLP attributes in addition to the native trace/span identifiers so
        // logs, metrics, traces, and persisted events can be joined uniformly.
        [telemetryAttributes.runId]: runId,
        [telemetryAttributes.traceId]: traceId,
        [telemetryAttributes.spanId]: spanId,
        ...(options.nodeId === undefined ? {} : { [telemetryAttributes.unitId]: options.nodeId }),
      },
    };

    await this.store.appendEvent(event);
    if (this.exporter !== undefined) {
      void this.exporter.export(event).catch(() => undefined);
    }
    return event;
  }

  public list(runId?: string): Promise<RunEvent[]> {
    return this.store.listEvents(runId);
  }

  public async recordEvidence(input: {
    runId: string;
    deploymentId?: string;
    tenantId?: string;
    projectId?: string;
    unitId: string;
    operation: string;
    idempotencyKey?: string;
    actor?: string;
    source?: string;
    correlationId?: string;
    status: OperationEvidenceStatus;
    attempt?: number;
    input?: unknown;
    output?: unknown;
    error?: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<OperationEvidence> {
    const scope = await this.store.read((state) => {
      const run = state.runs.find((candidate) => candidate.id === input.runId);
      return { tenantId: input.tenantId ?? run?.tenantId, projectId: input.projectId ?? run?.projectId, traceId: run?.traceId };
    });
    const evidence: OperationEvidence = {
      ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
      ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
      id: input.idempotencyKey === undefined
        ? randomUUID()
        : deterministicEvidenceId(input.runId, input.unitId, input.operation, input.status, input.idempotencyKey),
      runId: input.runId,
      unitId: input.unitId,
      operation: input.operation,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      actor: input.actor?.trim() || 'runtime',
      source: input.source?.trim() || 'local-executor',
      ...(input.correlationId === undefined && scope.traceId === undefined ? {} : { correlationId: input.correlationId ?? scope.traceId }),
      attempt: input.attempt ?? 1,
      status: input.status,
      occurredAt: new Date().toISOString(),
      ...(input.input === undefined ? {} : { inputHash: createHash('sha256').update(JSON.stringify(input.input)).digest('hex') }),
      ...(input.output === undefined ? {} : { outputHash: createHash('sha256').update(JSON.stringify(input.output)).digest('hex') }),
      ...(input.error === undefined ? {} : { error: input.error.slice(0, 2_000) }),
      ...(input.metadata === undefined ? {} : { metadata: sanitizeMetadata(input.metadata) }),
    };
    await this.store.appendEvidence(evidence);
    return evidence;
  }

  public listEvidence(query?: string | EvidenceQuery): Promise<OperationEvidence[]> {
    return this.store.listEvidence(query);
  }

  /** Replace an oversized JSON payload with a durable artifact reference. */
  public async offloadPayload(runId: string, payload: unknown, kind: string): Promise<unknown> {
    if (this.artifactStore === undefined) return payload;
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return payload;
    }
    if (Buffer.byteLength(serialized, 'utf8') <= this.inlineDataBytes) return payload;
    const scope = await this.store.read((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      return { tenantId: run?.tenantId, projectId: run?.projectId };
    });
    const reference = await this.artifactStore.put({
      kind,
      content: serialized,
      contentType: 'application/json',
      runId,
      ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    });
    return { artifactRef: reference };
  }

  /** Resolve an artifact-backed payload before delivering it to a downstream unit. */
  public async resolvePayload(payload: unknown): Promise<unknown> {
    if (this.artifactStore === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const reference = (payload as { artifactRef?: unknown }).artifactRef;
    if (reference === null || typeof reference !== 'object' || typeof (reference as { id?: unknown }).id !== 'string') return payload;
    const artifact = await this.artifactStore.get((reference as { id: string }).id);
    if (artifact.reference.contentType === 'application/json') return JSON.parse(new TextDecoder().decode(artifact.content));
    return artifact.content;
  }

  public prune(): Promise<number> {
    const before = new Date(Date.now() - this.retentionHours * 60 * 60 * 1000).toISOString();
    const evidenceBefore = this.evidenceRetentionHours === undefined
      ? undefined
      : new Date(Date.now() - this.evidenceRetentionHours * 60 * 60 * 1000).toISOString();
    return this.store.listEvents().then(async (events) => {
      const traceIds = [...new Set(events
        .filter((event) => event.timestamp < before)
        .map((event) => event.traceId))];
      const deleted = this.store.pruneEvents === undefined ? 0 : await this.store.pruneEvents(before);
      const deletedEvidence = evidenceBefore === undefined || this.store.pruneEvidence === undefined ? 0 : await this.store.pruneEvidence(evidenceBefore);
      const deletedArtifacts = this.artifactStore === undefined ? 0 : await this.artifactStore.prune(before);
      await this.exporter?.prune?.(traceIds);
      return deleted + deletedEvidence + deletedArtifacts;
    });
  }

  public close(): Promise<void> {
    return Promise.all([
      this.exporter?.close?.() ?? Promise.resolve(),
      this.artifactStore?.close?.() ?? Promise.resolve(),
    ]).then(() => undefined);
  }
}

function deterministicEvidenceId(runId: string, unitId: string, operation: string, status: OperationEvidenceStatus, idempotencyKey: string): string {
  const digest = createHash('sha256').update(JSON.stringify({ runId, unitId, operation, status, idempotencyKey })).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const sensitiveMetadataKey = /(secret|token|password|authorization|api[._-]?key|prompt|output|credential)/i;

function sanitizeMetadata(metadata: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const retained: Array<[string, string | number | boolean]> = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (sensitiveMetadataKey.test(key)) continue;
    retained.push([key, typeof value === 'string' ? value.slice(0, 500) : value]);
  }
  return Object.fromEntries(retained);
}
