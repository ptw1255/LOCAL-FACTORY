import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { WorkUnitTimeoutError } from '../runtime/work-unit-dispatcher.js';
import { configureTemporalObservabilitySink, executeNodeActivity, linkTemporalCancellation, TemporalActivityUnsupportedError } from './activities.js';

describe('Temporal node activities', () => {
  it('executes deterministic nodes through the WorkUnit contract', async () => {
    const result = await executeNodeActivity({
      runId: 'run-temporal',
      traceId: 'trace-temporal',
      sequence: 2,
      nodeId: 'normalize',
      nodeType: 'code',
      label: 'Normalize',
      config: { operation: 'uppercase', value: 'hello' },
      inputs: ['input'],
      unit: { ...defaultWorkUnit('code'), inputSchema: 'string', outputSchema: 'string' },
    });
    expect(result).toMatchObject({
      nodeId: 'normalize',
      result: 'HELLO',
      lifecycle: {
        runId: 'run-temporal',
        nodeId: 'normalize',
        traceId: 'trace-temporal',
        sequence: 2,
        status: 'succeeded',
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('enforces output schemas before Temporal completion', async () => {
    await expect(executeNodeActivity({
      runId: 'run-temporal',
      nodeId: 'parse',
      nodeType: 'code',
      label: 'Parse',
      config: { operation: 'json.parse', value: '{"ok":true}' },
      unit: { ...defaultWorkUnit('code'), outputSchema: 'string' },
    })).rejects.toThrow('output');
  });

  it('reports started and succeeded lifecycle records to the configured sink', async () => {
    const lifecycle: Array<{ status: string; traceId: string; spanId: string }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push(record); } });
    try {
      await executeNodeActivity({
        runId: 'run-sink',
        traceId: 'trace-sink',
        nodeId: 'normalize',
        nodeType: 'code',
        label: 'Normalize',
        config: { operation: 'uppercase', value: 'hello' },
        unit: defaultWorkUnit('code'),
      });
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle.map((record) => record.status)).toEqual(['started', 'succeeded']);
    expect(lifecycle.every((record) => record.traceId === 'trace-sink' && record.spanId.length === 16)).toBe(true);
  });

  it('preserves a non-first Temporal attempt in lifecycle records', async () => {
    const lifecycle: Array<{ status: string; attempt: number }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push(record); } });
    try {
      await executeNodeActivity({
        runId: 'run-retry',
        nodeId: 'normalize',
        nodeType: 'code',
        label: 'Normalize',
        config: { operation: 'uppercase', value: 'retry' },
        attempt: 3,
        unit: defaultWorkUnit('code'),
      });
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle.map((record) => record.attempt)).toEqual([3, 3]);
  });

  it('reports a failed lifecycle when activity execution rejects', async () => {
    const lifecycle: Array<{ status: string; error?: string }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push(record); } });
    try {
      await expect(executeNodeActivity({
        runId: 'run-failed-sink',
        traceId: 'trace-failed-sink',
        nodeId: 'unsupported',
        nodeType: 'code',
        label: 'Unsupported',
        config: { operation: 'not-allowed' },
        unit: defaultWorkUnit('code'),
      })).rejects.toThrow('Unsupported deterministic code operation');
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle.map((record) => record.status)).toEqual(['started', 'failed']);
    expect(lifecycle[1]?.error).toContain('Unsupported deterministic code operation');
  });

  it('fails closed for unsupported Temporal node types instead of returning a placeholder result', async () => {
    const error = await executeNodeActivity({
      runId: 'run-unsupported',
      nodeId: 'repository',
      nodeType: 'repositoryMutation',
      label: 'Repository mutation',
      config: { operations: [] },
      unit: defaultWorkUnit('repositoryMutation'),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TemporalActivityUnsupportedError);
    expect(error).toMatchObject({ code: 'TEMPORAL_ACTIVITY_UNSUPPORTED', nodeType: 'repositoryMutation' });
  });

  it('does not report simulated agent completion on the Temporal worker', async () => {
    const error = await executeNodeActivity({
      runId: 'run-agent',
      nodeId: 'agent',
      nodeType: 'agentLoop',
      label: 'Agent',
      config: { maxIterations: 1 },
      unit: defaultWorkUnit('agentLoop'),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TemporalActivityUnsupportedError);
    expect(error).toMatchObject({ code: 'TEMPORAL_ACTIVITY_UNSUPPORTED', nodeType: 'agentLoop' });
  });

  it('completes an approval activity after the workflow signal is received', async () => {
    const lifecycle: Array<{ status: string; nodeId: string }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push({ status: record.status, nodeId: record.nodeId }); } });
    try {
      await expect(executeNodeActivity({
        runId: 'run-approval',
        nodeId: 'approve',
        nodeType: 'approval',
        label: 'Approve',
        config: {},
        unit: defaultWorkUnit('approval'),
      })).resolves.toMatchObject({ nodeId: 'approve', result: true });
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle).toEqual([{ status: 'started', nodeId: 'approve' }, { status: 'succeeded', nodeId: 'approve' }]);
  });

  it('enforces WorkUnit timeouts for Temporal activities', async () => {
    await expect(executeNodeActivity({
      runId: 'run-temporal',
      nodeId: 'wait',
      nodeType: 'wait',
      label: 'Wait',
      config: { durationMs: 50 },
      unit: { ...defaultWorkUnit('wait'), timeoutMs: 5 },
    })).rejects.toBeInstanceOf(WorkUnitTimeoutError);
  });

  it('propagates and then detaches Temporal cancellation listeners', () => {
    const source = new AbortController();
    const target = new AbortController();
    const unlink = linkTemporalCancellation(target, source.signal);
    const reason = new Error('worker shutdown');
    source.abort(reason);
    expect(target.signal.aborted).toBe(true);
    expect(target.signal.reason).toBe(reason);

    unlink();
    const secondSource = new AbortController();
    const secondTarget = new AbortController();
    const unlinkSecond = linkTemporalCancellation(secondTarget, secondSource.signal);
    unlinkSecond();
    secondSource.abort(new Error('late shutdown'));
    expect(secondTarget.signal.aborted).toBe(false);
  });
});
