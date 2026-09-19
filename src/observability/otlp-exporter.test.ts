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
  it('does not export traces', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {});

    await exporter.export(baseEvent);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send non-trace signals to a Phoenix trace-only exporter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { signals: ['log'] });

    await exporter.export({ ...baseEvent, signal: 'metric' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts credential-like attributes from every OTLP signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://collector:4318', {}, { signals: ['log'] });

    await exporter.export({ ...baseEvent, signal: 'log', attributes: { ...baseEvent.attributes, authorization: 'bearer secret', token: 'secret', 'api.key': 'secret' } });

    const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string }> }> }> }> };
    const keys = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes.map((item) => item.key);
    expect(keys).not.toEqual(expect.arrayContaining(['authorization', 'token', 'api.key']));
  });

  it('exposes export failures as health state without rejecting the workflow call', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('collector unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exporter = new OtlpHttpExporter('http://collector:4318', {}, { signals: ['log'] });

    await expect(exporter.export({ ...baseEvent, signal: 'log' })).resolves.toBeUndefined();
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
    const exporter = new OtlpHttpExporter('http://collector:4318', {}, { signals: ['log'] });

    await exporter.export({ ...baseEvent, signal: 'log' });
    await exporter.export({ ...baseEvent, signal: 'log' });
    expect(exporter.health()).toMatchObject({ status: 'degraded', failureCount: 1, lastSuccessAt: expect.any(String) });
    vi.restoreAllMocks();
  });

  it('does not issue external trace-pruning calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { signals: ['log'] });

    await expect(exporter.prune(['a'.repeat(32)])).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'healthy', failureCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a missing Phoenix trace as an idempotent prune success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OtlpHttpExporter('http://phoenix:6006', {}, { signals: ['log'] });

    await expect(exporter.prune(['b'.repeat(32)])).resolves.toBeUndefined();
    expect(exporter.health()).toMatchObject({ status: 'healthy', failureCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
