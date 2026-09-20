import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';

import type { RunEvent } from '../domain/types.js';
import type { TelemetryExporter, TelemetryExporterHealth } from './otlp-exporter.js';
import { telemetryResource } from './semconv.js';

type Signal = 'log' | 'metric';

interface ExporterHealthState {
  failureCount: number;
  lastErrorAt?: string;
  lastSuccessAt?: string;
}

export interface OtelSdkExporterOptions {
  headers?: Record<string, string>;
  signals?: Signal[];
  /** Prompt/output-like attributes are excluded unless explicitly enabled. */
  capturePayload?: boolean;
  exportIntervalMillis?: number;
  exporterFactories?: {
    logs?: () => LogRecordExporter;
    metrics?: () => PushMetricExporter;
  };
}

function endpointForSignal(endpoint: string, signal: 'log' | 'metric'): string {
  const base = endpoint.replace(/\/$/, '');
  const signalPath = signal === 'log' ? 'logs' : 'metrics';
  if (base.endsWith(`/v1/${signalPath}`)) return base;
  return `${base}/v1/${signalPath}`;
}

function spanAttributes(event: RunEvent, capturePayload: boolean): Attributes {
  return Object.fromEntries(
    Object.entries(event.attributes ?? {}).filter(([key]) => {
      if (/(secret|token|password|authorization|api[._-]?key|credential)/i.test(key)) return false;
      return capturePayload || !/(prompt|input|output|completion|content)/i.test(key);
    }),
  );
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

/** Official OpenTelemetry SDK exporter for compact logs and metrics. */
export class OtelSdkExporter implements TelemetryExporter {
  private readonly signals: Set<Signal>;
  private readonly headers: Record<string, string>;
  private readonly capturePayload: boolean;
  private readonly exportIntervalMillis: number;
  private readonly factories: NonNullable<OtelSdkExporterOptions['exporterFactories']>;
  private readonly state: ExporterHealthState = { failureCount: 0 };
  private logProvider: LoggerProvider | undefined;
  private metricProvider: MeterProvider | undefined;
  private readonly metricInstruments = new Map<string, { record(value: number, attributes?: Attributes): void }>();

  public constructor(private readonly endpoint: string, options: OtelSdkExporterOptions = {}) {
    this.signals = new Set(options.signals ?? ['log', 'metric']);
    this.headers = options.headers ?? {};
    this.capturePayload = options.capturePayload ?? false;
    this.exportIntervalMillis = Math.max(100, options.exportIntervalMillis ?? 5_000);
    this.factories = options.exporterFactories ?? {};
  }

  public async export(event: RunEvent): Promise<void> {
    if (event.signal === 'trace' || !this.signals.has(event.signal)) return;
    const failuresBeforeExport = this.state.failureCount;
    try {
      if (event.signal === 'log') await this.exportLog(event);
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

  private async exportLog(event: RunEvent): Promise<void> {
    this.logProvider ??= new LoggerProvider({
      resource: resourceFromAttributes(telemetryResource),
      processors: [new BatchLogRecordProcessor({
        exporter: new TrackingLogExporter(
          this.factories.logs?.() ?? new OTLPLogExporter({ url: endpointForSignal(this.endpoint, 'log'), headers: this.headers }),
          this.state,
        ),
        scheduledDelayMillis: this.exportIntervalMillis,
      })],
    });
    const logger = this.logProvider.getLogger('agentic-workflow-factory');
    logger.emit({
      eventName: event.type,
      timestamp: new Date(event.timestamp),
      severityText: event.severityText ?? 'INFO',
      severityNumber: severityNumber(event.severityText),
      body: event.message,
      attributes: spanAttributes(event, this.capturePayload),
    });
    await this.logProvider.forceFlush();
  }

  private async exportMetric(event: RunEvent): Promise<void> {
    this.metricProvider ??= new MeterProvider({
      resource: resourceFromAttributes(telemetryResource),
      readers: [new PeriodicExportingMetricReader({
        exporter: new TrackingMetricExporter(
          this.factories.metrics?.() ?? new OTLPMetricExporter({ url: endpointForSignal(this.endpoint, 'metric'), headers: this.headers }),
          this.state,
        ),
        exportIntervalMillis: this.exportIntervalMillis,
      })],
    });
    const meter = this.metricProvider.getMeter('agentic-workflow-factory');
    const name = metricName(event);
    let instrument = this.metricInstruments.get(name);
    if (instrument === undefined) {
      instrument = meter.createHistogram(name, { unit: '1' });
      this.metricInstruments.set(name, instrument);
    }
    instrument.record(metricValue(event), spanAttributes(event, this.capturePayload));
    await this.metricProvider.forceFlush();
  }

  public health(): TelemetryExporterHealth {
    return {
      status: this.state.failureCount === 0 ? 'healthy' : 'degraded',
      failureCount: this.state.failureCount,
      ...(this.state.lastErrorAt === undefined ? {} : { lastErrorAt: this.state.lastErrorAt }),
      ...(this.state.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.state.lastSuccessAt }),
    };
  }

  public async prune(_traceIds: string[]): Promise<void> {
    // Trace export is disabled, so there is no external trace retention work.
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.logProvider?.shutdown() ?? Promise.resolve(),
      this.metricProvider?.shutdown() ?? Promise.resolve(),
    ]);
  }
}
