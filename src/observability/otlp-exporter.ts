import type { RunEvent } from '../domain/types.js';

type Primitive = string | number | boolean;

export interface TelemetryExporter {
  export(event: RunEvent): Promise<void>;
  prune?(traceIds: string[]): Promise<void>;
  close?(): Promise<void>;
  health?(): TelemetryExporterHealth;
}

export interface TelemetryExporterHealth {
  status: 'healthy' | 'degraded';
  failureCount: number;
  lastErrorAt?: string;
  lastSuccessAt?: string;
}

interface OtlpAttribute {
  key: string;
  value: Record<string, Primitive>;
}

const resourceKeys = new Set([
  'service.name',
  'service.version',
  'telemetry.sdk.name',
  'tenant.id',
  'project.id',
  'deployment.environment',
]);

function attributeValue(value: Primitive): Record<string, Primitive> {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: value };
}

function attributes(event: RunEvent): OtlpAttribute[] {
  return Object.entries(event.attributes ?? {}).filter(([key]) => !/(secret|token|password|authorization|api[._-]?key|credential)/i.test(key)).map(([key, value]) => ({
    key,
    value: attributeValue(value),
  }));
}

function unixNanos(timestamp: string): string {
  return `${BigInt(new Date(timestamp).getTime()) * 1_000_000n}`;
}

function resource(event: RunEvent) {
  // Resource attributes describe the emitting service and its deployment
  // scope. Run/span/unit correlation belongs on the signal itself; keeping it
  // out of the resource avoids duplicating high-cardinality data in OTLP
  // backends while preserving tenant/project joins.
  const resourceEvent = {
    ...event,
    attributes: Object.fromEntries(
      Object.entries(event.attributes ?? {}).filter(([key]) => resourceKeys.has(key)),
    ),
  };
  return {
    attributes: attributes(resourceEvent),
  };
}

function tracePayload(event: RunEvent) {
  const durationMs = typeof event.data?.durationMs === 'number' ? event.data.durationMs : 1;
  const end = new Date(new Date(event.timestamp).getTime() + Math.max(1, durationMs)).toISOString();
  return {
    resourceSpans: [{
      resource: resource(event),
      scopeSpans: [{
        scope: { name: 'agentic-workflow-factory' },
        spans: [{
          traceId: event.traceId,
          spanId: event.spanId,
          ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
          name: event.type,
          kind: 1,
          startTimeUnixNano: unixNanos(event.timestamp),
          endTimeUnixNano: unixNanos(end),
          attributes: attributes(event),
          status: { code: event.severityText === 'ERROR' ? 2 : 1 },
          events: [{
            name: event.message,
            timeUnixNano: unixNanos(event.timestamp),
          }],
        }],
      }],
    }],
  };
}

function logPayload(event: RunEvent) {
  return {
    resourceLogs: [{
      resource: resource(event),
      scopeLogs: [{
        scope: { name: 'agentic-workflow-factory' },
        logRecords: [{
          timeUnixNano: unixNanos(event.timestamp),
          ...(event.severityText === undefined ? {} : { severityText: event.severityText }),
          body: { stringValue: event.message },
          attributes: attributes(event),
        }],
      }],
    }],
  };
}

function metricPayload(event: RunEvent) {
  const metricName = event.attributes?.['metric.name'] ?? event.type;
  const metricValue = event.attributes?.['metric.value'] ?? event.data?.durationMs ?? 1;
  const value = typeof metricValue === 'number' ? metricValue : Number(metricValue);
  return {
    resourceMetrics: [{
      resource: resource(event),
      scopeMetrics: [{
        scope: { name: 'agentic-workflow-factory' },
        metrics: [{
          name: String(metricName),
          gauge: { dataPoints: [{
            timeUnixNano: unixNanos(event.timestamp),
            asDouble: Number.isFinite(value) ? value : 0,
            attributes: attributes(event),
          }] },
        }],
      }],
    }],
  };
}

/** Small dependency-free OTLP/HTTP exporter for local development and sidecars. */
export class OtlpHttpExporter implements TelemetryExporter {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly deleteTraces: boolean;
  private readonly signals: Set<RunEvent['signal']>;
  private failureCount = 0;
  private lastErrorAt?: string;
  private lastSuccessAt?: string;

  public constructor(
    endpoint: string,
    headers: Record<string, string> = {},
    options: { deleteTraces?: boolean; signals?: RunEvent['signal'][] } = {},
  ) {
    this.baseUrl = endpoint.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...headers };
    this.deleteTraces = options.deleteTraces ?? false;
    this.signals = new Set(options.signals ?? ['log', 'trace', 'metric']);
  }

  public async export(event: RunEvent): Promise<void> {
    if (!this.signals.has(event.signal)) return;
    const path = event.signal === 'trace' ? '/v1/traces' : event.signal === 'log' ? '/v1/logs' : '/v1/metrics';
    const payload = event.signal === 'trace'
      ? tracePayload(event)
      : event.signal === 'log'
        ? logPayload(event)
        : metricPayload(event);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        throw new Error(`OTLP export failed with HTTP ${response.status}.`);
      }
      this.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      this.failureCount += 1;
      this.lastErrorAt = new Date().toISOString();
      // Telemetry must never stop a workflow run. Callers may observe this via their logger.
      console.warn('[telemetry] OTLP export failed', error);
    }
  }

  public health(): TelemetryExporterHealth {
    return {
      status: this.failureCount === 0 ? 'healthy' : 'degraded',
      failureCount: this.failureCount,
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
      ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt }),
    };
  }

  public async prune(traceIds: string[]): Promise<void> {
    if (!this.deleteTraces) return;
    await Promise.all(traceIds.map(async (traceId) => {
      try {
        const response = await fetch(`${this.baseUrl}/v1/traces/${encodeURIComponent(traceId)}`, {
          method: 'DELETE',
          headers: this.headers,
          signal: AbortSignal.timeout(2_000),
        });
        // Deletion is idempotent for an already-expired trace, but backend
        // failures must remain visible through the same health contract as
        // export failures so retention drift is not silently hidden.
        if (!response.ok && response.status !== 404) throw new Error(`Phoenix trace deletion failed with HTTP ${response.status}.`);
        if (response.ok) this.lastSuccessAt = new Date().toISOString();
      } catch (error) {
        this.failureCount += 1;
        this.lastErrorAt = new Date().toISOString();
        console.warn('[telemetry] Phoenix trace deletion failed', error);
      }
    }));
  }
}

export class CompositeTelemetryExporter implements TelemetryExporter {
  public constructor(private readonly exporters: TelemetryExporter[]) {}

  public async export(event: RunEvent): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => exporter.export(event)));
  }

  public async prune(traceIds: string[]): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => exporter.prune?.(traceIds)));
  }

  public async close(): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => exporter.close?.()));
  }

  public health(): TelemetryExporterHealth {
    const health = this.exporters.map((exporter) => exporter.health?.()).filter((value): value is TelemetryExporterHealth => value !== undefined);
    const latest = (key: 'lastErrorAt' | 'lastSuccessAt'): string | undefined => health
      .map((value) => value[key])
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    const lastErrorAt = latest('lastErrorAt');
    const lastSuccessAt = latest('lastSuccessAt');
    return {
      status: health.some((value) => value.status === 'degraded') ? 'degraded' : 'healthy',
      failureCount: health.reduce((total, value) => total + value.failureCount, 0),
      ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    };
  }
}
