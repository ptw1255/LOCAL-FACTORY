import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import type { WorkflowNode } from '../domain/types.js';
import { WorkUnitDispatcher, WorkUnitTimeoutError } from './work-unit-dispatcher.js';

const node: WorkflowNode = {
  id: 'unit-1',
  type: 'code',
  label: 'Normalize',
  position: { x: 0, y: 0 },
  config: {},
  unit: { ...defaultWorkUnit('code'), inputSchema: 'string', outputSchema: 'string' },
};

function context(overrides: Partial<Parameters<WorkUnitDispatcher['dispatch']>[1]> = {}) {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    sequence: 1,
    node,
    inputs: ['input'],
    signal: new AbortController().signal,
    execute: () => 'output',
    ...overrides,
  };
}

describe('WorkUnitDispatcher', () => {
  it('builds a typed envelope and routes through the registered adapter', async () => {
    const dispatcher = new WorkUnitDispatcher();
    const calls: unknown[] = [];
    dispatcher.register('deterministic', 1, ({ envelope }) => {
      calls.push(envelope);
      return 'normalized';
    });

    const result = await dispatcher.dispatch(node.unit, context());

    expect(result).toBe('normalized');
    expect(calls[0]).toEqual(expect.objectContaining({
      runId: 'run-1',
      traceId: 'trace-1',
      unitId: 'unit-1',
      sequence: 1,
      attempt: 1,
      schema: 'string',
      payload: 'input',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('rejects invalid input and output payloads before downstream delivery', async () => {
    const dispatcher = new WorkUnitDispatcher();
    await expect(dispatcher.dispatch(node.unit, context({ inputs: [42] }))).rejects.toThrow('input');
    await expect(dispatcher.dispatch(node.unit, context({ execute: () => 42 }))).rejects.toThrow('output');
  });

  it('retries a failed adapter only within the declared bound', async () => {
    const dispatcher = new WorkUnitDispatcher();
    const retrying = { ...node.unit!, retryAttempts: 2 };
    let attempts = 0;
    dispatcher.register('deterministic', 1, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 'recovered';
    });
    await expect(dispatcher.dispatch(retrying, context())).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('fails closed for an unregistered version', async () => {
    const dispatcher = new WorkUnitDispatcher();
    await expect(dispatcher.dispatch({ ...node.unit!, version: 2 }, context())).rejects.toThrow('deterministic@2');
  });

  it('requires idempotency keys for side-effecting units and carries them in the envelope', async () => {
    const dispatcher = new WorkUnitDispatcher();
    const connector = { ...node.unit!, kind: 'connector' as const, idempotencyKey: undefined };
    await expect(dispatcher.dispatch(connector, context())).rejects.toThrow('idempotency key');
    const calls: unknown[] = [];
    dispatcher.register('connector', 1, ({ envelope }) => { calls.push(envelope); return 'output'; });
    await expect(dispatcher.dispatch({ ...connector, idempotencyKey: 'connector:unit-1' }, context())).resolves.toBe('output');
    expect(calls[0]).toEqual(expect.objectContaining({ idempotencyKey: 'connector:unit-1' }));
  });

  it('never retries a side-effecting connector after an uncertain failure', async () => {
    const dispatcher = new WorkUnitDispatcher();
    let attempts = 0;
    dispatcher.register('connector', 1, () => {
      attempts += 1;
      throw new Error('external request outcome is unknown');
    });
    await expect(dispatcher.dispatch({ ...node.unit!, kind: 'connector', retryAttempts: 3, idempotencyKey: 'connector:once' }, context())).rejects.toThrow('unknown');
    expect(attempts).toBe(1);
  });

  it('resolves named schemas and rejects unknown references', async () => {
    const dispatcher = new WorkUnitDispatcher({
      'review-input': (payload) => typeof payload === 'object' && payload !== null && 'request' in payload,
    });
    const named = { ...node.unit!, inputSchema: '$ref:review-input' };
    await expect(dispatcher.dispatch(named, context({ inputs: [{ request: 'check' }] }))).resolves.toBe('output');
    await expect(dispatcher.dispatch(named, context({ inputs: [{ wrong: true }] }))).rejects.toThrow('input');
    await expect(dispatcher.dispatch({ ...node.unit!, inputSchema: '$ref:missing' }, context())).rejects.toThrow('unknown schema');
  });

  it('aborts a timed-out adapter and reports the bounded timeout', async () => {
    const dispatcher = new WorkUnitDispatcher();
    const timed = { ...node.unit!, timeoutMs: 10 };
    dispatcher.register('deterministic', 1, ({ context: dispatchContext }) => new Promise((_resolve, reject) => {
      dispatchContext.signal.addEventListener('abort', () => reject(dispatchContext.signal.reason), { once: true });
    }));
    await expect(dispatcher.dispatch(timed, context())).rejects.toBeInstanceOf(WorkUnitTimeoutError);
  });
});
