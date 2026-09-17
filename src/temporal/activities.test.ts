import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { WorkUnitTimeoutError } from '../runtime/work-unit-dispatcher.js';
import { configureTemporalObservabilitySink, configureTemporalRepositoryWorkspace, executeNodeActivity, linkTemporalCancellation, TemporalActivityUnsupportedError } from './activities.js';
import { RepositoryWorkspace } from '../repository/workspace.js';

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

  it('executes evaluator modes and enforces threshold failures', async () => {
    await expect(executeNodeActivity({
      runId: 'run-evaluator',
      nodeId: 'score',
      nodeType: 'evaluator',
      label: 'Score',
      config: { mode: 'fieldEquals', field: 'status', expected: 'ready', threshold: 1 },
      inputs: [{ status: 'ready' }],
      unit: defaultWorkUnit('evaluator'),
    })).resolves.toMatchObject({ result: { score: 1, threshold: 1, passed: true, mode: 'fieldEquals' } });
    await expect(executeNodeActivity({
      runId: 'run-evaluator-failed',
      nodeId: 'score',
      nodeType: 'evaluator',
      label: 'Score',
      config: { mode: 'exists', threshold: 1, failOnThreshold: true },
      inputs: [null],
      unit: defaultWorkUnit('evaluator'),
    })).rejects.toThrow('Evaluator threshold failed');
  });

  it('executes repository checks through the configured Temporal workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-check-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const workspace = await RepositoryWorkspace.open(directory);
    configureTemporalRepositoryWorkspace(workspace);
    try {
      await expect(executeNodeActivity({
        runId: 'run-repository-check',
        nodeId: 'check',
        nodeType: 'repositoryCheck',
        label: 'Run tests',
        config: { command: 'npm test' },
        unit: defaultWorkUnit('repositoryCheck'),
      })).resolves.toMatchObject({ result: { command: 'npm test', exitCode: 0, required: true, promotionBlocked: false, timedOut: false } });
    } finally {
      configureTemporalRepositoryWorkspace(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails required Temporal repository checks and permits advisory failures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-check-fail-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(2)"' } }));
    const workspace = await RepositoryWorkspace.open(directory);
    configureTemporalRepositoryWorkspace(workspace);
    try {
      await expect(executeNodeActivity({
        runId: 'run-repository-check-required', nodeId: 'check', nodeType: 'repositoryCheck', label: 'Required check',
        config: { command: 'npm test' }, unit: defaultWorkUnit('repositoryCheck'),
      })).rejects.toThrow('Required repository check failed');
      await expect(executeNodeActivity({
        runId: 'run-repository-check-advisory', nodeId: 'check', nodeType: 'repositoryCheck', label: 'Advisory check',
        config: { command: 'npm test', required: false }, unit: defaultWorkUnit('repositoryCheck'),
      })).resolves.toMatchObject({ result: { exitCode: 2, required: false, promotionBlocked: false } });
    } finally {
      configureTemporalRepositoryWorkspace(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-HTTP(S) URLs before making a Temporal request', async () => {
    await expect(executeNodeActivity({
      runId: 'run-http-policy',
      nodeId: 'request',
      nodeType: 'httpRequest',
      label: 'Request',
      config: { url: 'file:///etc/passwd' },
      unit: defaultWorkUnit('httpRequest'),
    })).rejects.toThrow('only http and https URLs');
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
