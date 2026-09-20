import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExportResultCode } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';

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
  it('does not emit OpenTelemetry traces', async () => {
    const exporter = new OtelSdkExporter('http://unused');

    await exporter.export(baseEvent);
    await exporter.export({ ...baseEvent, signal: 'trace' });
    expect(exporter.health()).toMatchObject({ status: 'healthy', failureCount: 0 });
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

  it('never forwards credential-like attributes even when payload capture is enabled', async () => {
    const logs = logExporter();
    const exporter = new OtelSdkExporter('http://unused', {
      capturePayload: true,
      exporterFactories: { logs: () => logs },
    });

    await exporter.export({ ...baseEvent, signal: 'log', attributes: { ...baseEvent.attributes, prompt: 'allowed only by explicit capture', authorization: 'bearer secret', 'api.key': 'secret' } });

    const attributes = logs.logs[0]?.attributes ?? {};
    expect(attributes).toHaveProperty('prompt');
    expect(attributes).not.toHaveProperty('authorization');
    expect(attributes).not.toHaveProperty('api.key');
  });

  it('records official SDK export failures without rejecting workflow execution', async () => {
    const failed: LogRecordExporter = {
      export: (_logs, callback) => callback({ code: ExportResultCode.FAILED }),
      forceFlush: async (): Promise<void> => undefined,
      shutdown: async (): Promise<void> => undefined,
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = new OtelSdkExporter('http://unused', { exporterFactories: { logs: () => failed } });

    await expect(exporter.export({ ...baseEvent, signal: 'log' })).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'degraded', failureCount: 1, lastErrorAt: expect.any(String) });
  });

  it('does not call an external trace deletion endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtelSdkExporter('http://phoenix:6006', { headers: { api_key: 'dev-key' } });

    await exporter.prune(['a'.repeat(32)]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
