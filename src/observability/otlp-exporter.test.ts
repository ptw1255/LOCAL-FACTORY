import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunEvent } from '../domain/types.js';
import { OtlpHttpExporter } from './otlp-exporter.js';

const baseEvent: RunEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-local',
  projectId: 'project-local',
  runId: 'run-1',
  type: 'agent.iteration',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: 'iteration',
  signal: 'trace',
  traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  spanId: 'bbbbbbbbbbbbbbbb',
  attributes: {
    'openinference.span.kind': 'AGENT',
    'tenant.id': 'tenant-local',
    'project.id': 'project-local',
    'run.id': 'run-1',
    'trace.id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'span.id': 'bbbbbbbbbbbbbbbb',
    'unit.id': 'agent-1',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OtlpHttpExporter', () => {
  it('exports a trace as an OTLP resource span', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { signals: ['trace'] });

    await exporter.export(baseEvent);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://phoenix:6006/v1/traces');
    const payload = JSON.parse(String(request.body)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string }> };
        scopeSpans?: Array<{ spans?: Array<{ attributes?: Array<{ key: string }> }> }>;
      }>;
    };
    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0]?.resource.attributes.map((item) => item.key)).toContain('project.id');
    expect(payload.resourceSpans[0]?.resource.attributes.map((item) => item.key)).not.toContain('run.id');
    const span = (payload.resourceSpans[0]?.scopeSpans?.[0] as { spans?: Array<{ attributes?: Array<{ key: string }> }> } | undefined)?.spans?.[0];
    expect(span?.attributes?.map((item) => item.key)).toEqual(expect.arrayContaining(['run.id', 'trace.id', 'span.id', 'unit.id']));
  });

  it('does not send non-trace signals to a Phoenix trace-only exporter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { signals: ['trace'] });

    await exporter.export({ ...baseEvent, signal: 'metric' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes export failures as health state without rejecting the workflow call', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('collector unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = new OtlpHttpExporter('http://collector:4318', {}, { signals: ['trace'] });

    await expect(exporter.export(baseEvent)).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'degraded', failureCount: 1, lastErrorAt: expect.any(String) });
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it('recovers health after a later successful export', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('collector unavailable'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = new OtlpHttpExporter('http://collector:4318', {}, { signals: ['trace'] });

    await exporter.export(baseEvent);
    await exporter.export(baseEvent);
    expect(exporter.health()).toMatchObject({ status: 'degraded', failureCount: 1, lastSuccessAt: expect.any(String) });
    vi.restoreAllMocks();
  });

  it('surfaces non-404 trace-pruning failures without rejecting retention', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { deleteTraces: true, signals: ['trace'] });

    await expect(exporter.prune(['a'.repeat(32)])).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'degraded', failureCount: 1, lastErrorAt: expect.any(String) });
    expect(warning).toHaveBeenCalled();
  });

  it('treats a missing Phoenix trace as an idempotent prune success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { deleteTraces: true, signals: ['trace'] });

    await expect(exporter.prune(['b'.repeat(32)])).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'healthy', failureCount: 0 });
  });
});
