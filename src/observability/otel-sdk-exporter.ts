import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type SpanContext,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type IdGenerator,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';

import type { RunEvent } from '../domain/types.js';
import type { TelemetryExporter, TelemetryExporterHealth } from './otlp-exporter.js';
import { telemetryResource } from './semconv.js';

type Primitive = string | number | boolean;
type Signal = RunEvent['signal'];

interface ExporterHealthState {
  failureCount: number;
  lastErrorAt?: string;
  lastSuccessAt?: string;
}

export interface OtelSdkExporterOptions {
  headers?: Record<string, string>;
  signals?: Signal[];
  /** Enable Phoenix's trace deletion endpoint during the factory retention pass. */
  deleteTraces?: boolean;
  /** Prompt/output-like attributes are excluded unless explicitly enabled. */
  capturePayload?: boolean;
  exportIntervalMillis?: number;
  exporterFactories?: {
    trace?: () => SpanExporter;
    logs?: () => LogRecordExporter;
    metrics?: () => PushMetricExporter;
  };
}

function endpointForSignal(endpoint: string, signal: Exclude<Signal, 'log' | 'trace' | 'metric'> | Signal): string {
  const base = endpoint.replace(/\/$/, '');
  const signalPath = signal === 'trace' ? 'traces' : signal === 'log' ? 'logs' : 'metrics';
  if (base.endsWith(`/v1/${signalPath}`)) return base;
  return `${base}/v1/${signalPath}`;
}

function validId(value: string, length: number): boolean {
  return new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value);
}

function safeTraceId(event: RunEvent): string {
  return validId(event.traceId, 32) ? event.traceId : '1'.repeat(32);
}

function safeSpanId(event: RunEvent): string {
  return validId(event.spanId, 16) ? event.spanId : '1'.repeat(16);
}

/** Generate the event's stable IDs so official SDK spans retain the factory's correlation IDs. */
class EventIdGenerator implements IdGenerator {
  public constructor(private readonly event: RunEvent) {}

  public generateTraceId(): string {
    return safeTraceId(this.event);
  }

  public generateSpanId(): string {
    return safeSpanId(this.event);
  }
}

function spanAttributes(event: RunEvent, capturePayload: boolean): Attributes {
  return Object.fromEntries(
    Object.entries(event.attributes ?? {}).filter(([key]) => {
      if (/(secret|token|password|authorization|api[._-]?key|credential)/i.test(key)) return false;
      return capturePayload || !/(prompt|input|output|completion|content)/i.test(key);
    }),
  );
}

function resourceAttributes(event: RunEvent): Record<string, Primitive> {
  const values: Record<string, Primitive> = { ...telemetryResource };
  for (const key of ['tenant.id', 'project.id', 'deployment.environment']) {
    const value = event.attributes?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = value;
  }
  return values;
}

function parentContext(event: RunEvent): ReturnType<typeof trace.setSpanContext> {
  if (!validId(safeTraceId(event), 32) || event.parentSpanId === undefined || !validId(event.parentSpanId, 16)) return ROOT_CONTEXT;
  const parent: SpanContext = {
    traceId: safeTraceId(event),
    spanId: event.parentSpanId,
    traceFlags: 1,
    isRemote: false,
  };
  return trace.setSpanContext(ROOT_CONTEXT, parent);
}

function spanKind(event: RunEvent): SpanKind {
  if (event.spanKind === 'tool') return SpanKind.CLIENT;
  if (event.spanKind === 'llm') return SpanKind.INTERNAL;
  return SpanKind.INTERNAL;
}

function severityNumber(value: RunEvent['severityText']): SeverityNumber {
  if (value === 'DEBUG') return SeverityNumber.DEBUG;
  if (value === 'WARN') return SeverityNumber.WARN;
  if (value === 'ERROR') return SeverityNumber.ERROR;
  return SeverityNumber.INFO;
}

function metricName(event: RunEvent): string {
  const configured = event.attributes?.['metric.name'] ?? event.type;
  return String(configured).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 255) || 'workflow.event';
}

function metricValue(event: RunEvent): number {
  const value = event.attributes?.['metric.value'] ?? event.data?.durationMs ?? 1;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function observeResult(state: ExporterHealthState, result: ExportResult): void {
  if (result.code === ExportResultCode.SUCCESS) {
    state.lastSuccessAt = new Date().toISOString();
    return;
  }
  state.failureCount += 1;
  state.lastErrorAt = new Date().toISOString();
}

class TrackingSpanExporter implements SpanExporter {
  public constructor(private readonly inner: SpanExporter, private readonly state: ExporterHealthState) {}

  public export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    try {
      this.inner.export(spans, (result) => {
        observeResult(this.state, result);
        callback(result);
      });
    } catch {
      observeResult(this.state, { code: ExportResultCode.FAILED });
      callback({ code: ExportResultCode.FAILED });
    }
  }

  public forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

class TrackingLogExporter implements LogRecordExporter {
  public constructor(private readonly inner: LogRecordExporter, private readonly state: ExporterHealthState) {}

  public export(logs: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    try {
      this.inner.export(logs, (result) => {
        observeResult(this.state, result);
        callback(result);
      });
    } catch {
      observeResult(this.state, { code: ExportResultCode.FAILED });
      callback({ code: ExportResultCode.FAILED });
    }
  }

  public forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

class TrackingMetricExporter implements PushMetricExporter {
  public constructor(private readonly inner: PushMetricExporter, private readonly state: ExporterHealthState) {}

  public export(metrics: ResourceMetrics, callback: (result: ExportResult) => void): void {
    try {
      this.inner.export(metrics, (result) => {
        observeResult(this.state, result);
        callback(result);
      });
    } catch {
      observeResult(this.state, { code: ExportResultCode.FAILED });
      callback({ code: ExportResultCode.FAILED });
    }
  }

  public forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/**
 * Official OpenTelemetry SDK exporter for local development and sidecars.
 *
 * A provider is scoped to one event so the factory's stable trace/span IDs can
 * be supplied through the SDK IdGenerator without sharing mutable state across
 * concurrent workflow runs. Export errors are recorded and never propagated to
 * the workflow executor.
 */
export class OtelSdkExporter implements TelemetryExporter {
  private readonly signals: Set<Signal>;
  private readonly headers: Record<string, string>;
  private readonly capturePayload: boolean;
  private readonly deleteTraces: boolean;
  private readonly exportIntervalMillis: number;
  private readonly factories: NonNullable<OtelSdkExporterOptions['exporterFactories']>;
  private readonly state: ExporterHealthState = { failureCount: 0 };

  public constructor(private readonly endpoint: string, options: OtelSdkExporterOptions = {}) {
    this.signals = new Set(options.signals ?? ['trace', 'log', 'metric']);
    this.headers = options.headers ?? {};
    this.capturePayload = options.capturePayload ?? false;
    this.deleteTraces = options.deleteTraces ?? false;
    this.exportIntervalMillis = Math.max(100, options.exportIntervalMillis ?? 5_000);
    this.factories = options.exporterFactories ?? {};
  }

  public async export(event: RunEvent): Promise<void> {
    if (!this.signals.has(event.signal)) return;
    const failuresBeforeExport = this.state.failureCount;
    try {
      if (event.signal === 'trace') await this.exportTrace(event);
      else if (event.signal === 'log') await this.exportLog(event);
      else await this.exportMetric(event);
    } catch (error) {
      // A tracking exporter records callback failures. Provider forceFlush can
      // then reject for the same failure; avoid counting that failure twice.
      if (this.state.failureCount === failuresBeforeExport) {
        this.state.failureCount += 1;
        this.state.lastErrorAt = new Date().toISOString();
      }
      console.warn('[telemetry] OpenTelemetry SDK export failed', error);
    }
  }

  private async exportTrace(event: RunEvent): Promise<void> {
    const exporter = new TrackingSpanExporter(
      this.factories.trace?.() ?? new OTLPTraceExporter({ url: endpointForSignal(this.endpoint, 'trace'), headers: this.headers }),
      this.state,
    );
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes(resourceAttributes(event)),
      idGenerator: new EventIdGenerator(event),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracer = provider.getTracer('agentic-workflow-factory');
      const span = tracer.startSpan(event.type, {
        kind: spanKind(event),
        startTime: new Date(event.timestamp),
        attributes: spanAttributes(event, this.capturePayload),
      }, parentContext(event));
      span.addEvent(event.message, new Date(event.timestamp));
      span.setStatus({ code: event.severityText === 'ERROR' ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      const durationMs = typeof event.data?.durationMs === 'number' ? Math.max(1, event.data.durationMs) : 1;
      span.end(new Date(new Date(event.timestamp).getTime() + durationMs));
      await provider.forceFlush();
    } finally {
      await provider.shutdown().catch(() => undefined);
    }
  }

  private async exportLog(event: RunEvent): Promise<void> {
    const exporter = new TrackingLogExporter(
      this.factories.logs?.() ?? new OTLPLogExporter({ url: endpointForSignal(this.endpoint, 'log'), headers: this.headers }),
      this.state,
    );
    const provider = new LoggerProvider({
      resource: resourceFromAttributes(resourceAttributes(event)),
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    try {
      const logger = provider.getLogger('agentic-workflow-factory');
      const span = validId(event.spanId, 16) ? {
        traceId: safeTraceId(event),
        spanId: event.spanId,
        traceFlags: 1,
        isRemote: false,
      } satisfies SpanContext : undefined;
      logger.emit({
        eventName: event.type,
        timestamp: new Date(event.timestamp),
        severityText: event.severityText ?? 'INFO',
        severityNumber: severityNumber(event.severityText),
        body: event.message,
        attributes: spanAttributes(event, this.capturePayload),
        ...(span === undefined ? {} : { context: trace.setSpanContext(context.active(), span) }),
      });
      await provider.forceFlush();
    } finally {
      await provider.shutdown().catch(() => undefined);
    }
  }

  private async exportMetric(event: RunEvent): Promise<void> {
    const exporter = new TrackingMetricExporter(
      this.factories.metrics?.() ?? new OTLPMetricExporter({ url: endpointForSignal(this.endpoint, 'metric'), headers: this.headers }),
      this.state,
    );
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: this.exportIntervalMillis });
    const provider = new MeterProvider({ resource: resourceFromAttributes(resourceAttributes(event)), readers: [reader] });
    try {
      const meter = provider.getMeter('agentic-workflow-factory');
      meter.createHistogram(metricName(event), { unit: '1' }).record(metricValue(event), spanAttributes(event, this.capturePayload));
      await provider.forceFlush();
    } finally {
      await provider.shutdown().catch(() => undefined);
    }
  }

  public health(): TelemetryExporterHealth {
    return {
      status: this.state.failureCount === 0 ? 'healthy' : 'degraded',
      failureCount: this.state.failureCount,
      ...(this.state.lastErrorAt === undefined ? {} : { lastErrorAt: this.state.lastErrorAt }),
      ...(this.state.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.state.lastSuccessAt }),
    };
  }

  public async prune(traceIds: string[]): Promise<void> {
    if (!this.deleteTraces) return;
    await Promise.all(traceIds.map(async (traceId) => {
      try {
        const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/v1/traces/${encodeURIComponent(traceId)}`, {
          method: 'DELETE',
          headers: this.headers,
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok && response.status !== 404) throw new Error(`Phoenix trace deletion failed with HTTP ${response.status}.`);
      } catch (error) {
        this.state.failureCount += 1;
        this.state.lastErrorAt = new Date().toISOString();
        console.warn('[telemetry] Phoenix trace deletion failed', error);
      }
    }));
  }
}
