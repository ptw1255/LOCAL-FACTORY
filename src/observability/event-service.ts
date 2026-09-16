import { createHash, randomUUID } from 'node:crypto';

import type { AgentSpanKind, OperationEvidence, OperationEvidenceStatus, RunEvent } from '../domain/types.js';
import type { PlatformStore } from '../storage/store.js';
import type { TelemetryExporter } from './otlp-exporter.js';
import { telemetryResource } from './semconv.js';

export class EventService {
  private readonly retentionHours: number;

  public constructor(
    private readonly store: PlatformStore,
    options: { retentionHours?: number; exporter?: TelemetryExporter } = {},
  ) {
    this.retentionHours = options.retentionHours ?? 48;
    this.exporter = options.exporter;
  }

  private readonly exporter: TelemetryExporter | undefined;

  public async emit(
    runId: string,
    type: string,
    message: string,
    options: {
      nodeId?: string;
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
    const event: RunEvent = {
      ...(runContext.tenantId === undefined ? {} : { tenantId: runContext.tenantId }),
      ...(runContext.projectId === undefined ? {} : { projectId: runContext.projectId }),
      id: randomUUID(),
      runId,
      type,
      timestamp: new Date().toISOString(),
      message,
      signal: options.signal ?? 'log',
      traceId: runContext.traceId ?? runId.replaceAll('-', '').padEnd(32, '0').slice(0, 32),
      spanId: randomUUID().replaceAll('-', '').slice(0, 16),
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      ...(options.data === undefined ? {} : { data: options.data }),
      ...(options.parentSpanId === undefined ? {} : { parentSpanId: options.parentSpanId }),
      ...(options.spanKind === undefined ? {} : { spanKind: options.spanKind }),
      ...(options.severityText === undefined ? {} : { severityText: options.severityText }),
      attributes: {
        ...telemetryResource,
        ...(runContext.tenantId === undefined ? {} : { 'tenant.id': runContext.tenantId }),
        ...(runContext.projectId === undefined ? {} : { 'project.id': runContext.projectId }),
        ...(options.attributes ?? {}),
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
    unitId: string;
    operation: string;
    status: OperationEvidenceStatus;
    attempt?: number;
    input?: unknown;
    output?: unknown;
    error?: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<OperationEvidence> {
    const scope = await this.store.read((state) => {
      const run = state.runs.find((candidate) => candidate.id === input.runId);
      return { tenantId: run?.tenantId, projectId: run?.projectId };
    });
    const evidence: OperationEvidence = {
      ...(scope.tenantId === undefined ? {} : { tenantId: scope.tenantId }),
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
      id: randomUUID(),
      runId: input.runId,
      unitId: input.unitId,
      operation: input.operation,
      attempt: input.attempt ?? 1,
      status: input.status,
      occurredAt: new Date().toISOString(),
      ...(input.input === undefined ? {} : { inputHash: createHash('sha256').update(JSON.stringify(input.input)).digest('hex') }),
      ...(input.output === undefined ? {} : { outputHash: createHash('sha256').update(JSON.stringify(input.output)).digest('hex') }),
      ...(input.error === undefined ? {} : { error: input.error.slice(0, 2_000) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    await this.store.appendEvidence(evidence);
    return evidence;
  }

  public listEvidence(runId?: string): Promise<OperationEvidence[]> {
    return this.store.listEvidence(runId);
  }

  public prune(): Promise<number> {
    if (this.store.pruneEvents === undefined) return Promise.resolve(0);
    const before = new Date(Date.now() - this.retentionHours * 60 * 60 * 1000).toISOString();
    return this.store.listEvents().then(async (events) => {
      const traceIds = [...new Set(events
        .filter((event) => event.timestamp < before)
        .map((event) => event.traceId))];
      const deleted = await this.store.pruneEvents!(before);
      await this.exporter?.prune?.(traceIds);
      return deleted;
    });
  }

  public close(): Promise<void> {
    return this.exporter?.close?.() ?? Promise.resolve();
  }
}
