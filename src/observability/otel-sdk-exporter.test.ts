import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExportResultCode } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import type { RunEvent } from '../domain/types.js';
import { OtelSdkExporter } from './otel-sdk-exporter.js';

const baseEvent: RunEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-local',
  projectId: 'project-local',
  runId: 'run-1',
  type: 'agent.iteration',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: 'iteration',
  signal: 'trace',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  attributes: {
    'openinference.span.kind': 'AGENT',
    'tenant.id': 'tenant-local',
    'project.id': 'project-local',
    'run.id': 'run-1',
    'trace.id': 'a'.repeat(32),
    'span.id': 'b'.repeat(16),
    'unit.id': 'agent-1',
    'llm.input_messages': 'do not export by default',
    'metric.name': 'workflow.iterations',
    'metric.value': 2,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

function traceExporter(): SpanExporter & { spans: ReadableSpan[] } {
  const value = {
    spans: [] as ReadableSpan[],
    export(spans: ReadableSpan[], callback: (result: { code: ExportResultCode }) => void): void {
      value.spans.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    forceFlush: async (): Promise<void> => undefined,
    shutdown: async (): Promise<void> => undefined,
  };
  return value;
}

function logExporter(): LogRecordExporter & { logs: ReadableLogRecord[] } {
  const value = {
    logs: [] as ReadableLogRecord[],
    export(logs: ReadableLogRecord[], callback: (result: { code: ExportResultCode }) => void): void {
      value.logs.push(...logs);
      callback({ code: ExportResultCode.SUCCESS });
    },
    forceFlush: async (): Promise<void> => undefined,
    shutdown: async (): Promise<void> => undefined,
  };
  return value;
}

function metricExporter(): PushMetricExporter & { metrics: ResourceMetrics[] } {
  const value = {
    metrics: [] as ResourceMetrics[],
    export(metrics: ResourceMetrics, callback: (result: { code: ExportResultCode }) => void): void {
      value.metrics.push(metrics);
      callback({ code: ExportResultCode.SUCCESS });
    },
    forceFlush: async (): Promise<void> => undefined,
    shutdown: async (): Promise<void> => undefined,
  };
  return value;
}

describe('OtelSdkExporter', () => {
  it('uses official SDK spans with stable IDs and parent-child relationships', async () => {
    const parent = traceExporter();
    const child = traceExporter();
    const exporter = new OtelSdkExporter('http://unused', {
      exporterFactories: { trace: () => parent },
    });

    await exporter.export(baseEvent);
    await exporter.export({
      ...baseEvent,
      id: '22222222-2222-4222-8222-222222222222',
      spanId: 'c'.repeat(16),
      parentSpanId: baseEvent.spanId,
      type: 'unit.completed',
    });

    expect(parent.spans).toHaveLength(2);
    expect(parent.spans[0]?.spanContext().traceId).toBe(baseEvent.traceId);
    expect(parent.spans[0]?.spanContext().spanId).toBe(baseEvent.spanId);
    expect(parent.spans[1]?.spanContext().spanId).toBe('c'.repeat(16));
    expect(parent.spans[1]?.parentSpanContext?.spanId).toBe(baseEvent.spanId);
    expect(child.spans).toHaveLength(0);
  });

  it('exports logs and metrics through the official SDK without prompt/output attributes', async () => {
    const logs = logExporter();
    const metrics = metricExporter();
    const exporter = new OtelSdkExporter('http://unused', {
      exporterFactories: { logs: () => logs, metrics: () => metrics },
    });

    await exporter.export({ ...baseEvent, signal: 'log', severityText: 'WARN' });
    await exporter.export({ ...baseEvent, signal: 'metric' });

    expect(logs.logs).toHaveLength(1);
    expect(logs.logs[0]?.body).toBe('iteration');
    expect(logs.logs[0]?.attributes).not.toHaveProperty('llm.input_messages');
    expect(metrics.metrics.length).toBeGreaterThan(0);
    expect(metrics.metrics[0]?.scopeMetrics[0]?.metrics[0]?.descriptor.name).toBe('workflow.iterations');
    expect(exporter.health()).toMatchObject({ status: 'healthy', failureCount: 0 });
  });

  it('records official SDK export failures without rejecting workflow execution', async () => {
    const failed: SpanExporter = {
      export: (_spans, callback) => callback({ code: ExportResultCode.FAILED }),
      shutdown: async (): Promise<void> => undefined,
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = new OtelSdkExporter('http://unused', { exporterFactories: { trace: () => failed } });

    await expect(exporter.export(baseEvent)).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'degraded', failureCount: 1, lastErrorAt: expect.any(String) });
    expect(warning).toHaveBeenCalled();
  });

  it('keeps Phoenix trace deletion aligned with the 48-hour factory retention pass', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtelSdkExporter('http://phoenix:6006', {
      deleteTraces: true,
      headers: { api_key: 'dev-key' },
    });

    await exporter.prune(['a'.repeat(32)]);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://phoenix:6006/v1/traces/${'a'.repeat(32)}`,
      expect.objectContaining({ method: 'DELETE', headers: { api_key: 'dev-key' } }),
    );
  });
});
