import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { WorkUnitTimeoutError } from '../runtime/work-unit-dispatcher.js';
import { configureTemporalObservabilitySink, executeNodeActivity } from './activities.js';

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
    await expect(executeNodeActivity({
      runId: 'run-unsupported',
      nodeId: 'repository',
      nodeType: 'repositoryMutation',
      label: 'Repository mutation',
      config: { operations: [] },
      unit: defaultWorkUnit('repositoryMutation'),
    })).rejects.toThrow('does not support node type');
  });

  it('does not report simulated agent completion on the Temporal worker', async () => {
    await expect(executeNodeActivity({
      runId: 'run-agent',
      nodeId: 'agent',
      nodeType: 'agentLoop',
      label: 'Agent',
      config: { maxIterations: 1 },
      unit: defaultWorkUnit('agentLoop'),
    })).rejects.toThrow('agentLoop activity adapter is not available');
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
});
