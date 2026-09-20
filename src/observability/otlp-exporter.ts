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
  private readonly signals: Set<'log' | 'metric'>;
  private failureCount = 0;
  private lastErrorAt?: string;
  private lastSuccessAt?: string;

  public constructor(
    endpoint: string,
    headers: Record<string, string> = {},
    options: { signals?: Array<'log' | 'metric'> } = {},
  ) {
    this.baseUrl = endpoint.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...headers };
    this.signals = new Set(options.signals ?? ['log', 'metric']);
  }

  public async export(event: RunEvent): Promise<void> {
    // Trace export is deliberately disabled while the compact run-summary
    // contract is active. Internal correlation IDs remain on run records.
    if (event.signal === 'trace' || !this.signals.has(event.signal)) return;
    const path = event.signal === 'log' ? '/v1/logs' : '/v1/metrics';
    const payload = event.signal === 'log' ? logPayload(event) : metricPayload(event);
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

  public async prune(_traceIds: string[]): Promise<void> {
    // Trace export and remote trace deletion are disabled for the compact
    // telemetry profile. The argument remains for interface compatibility.
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
