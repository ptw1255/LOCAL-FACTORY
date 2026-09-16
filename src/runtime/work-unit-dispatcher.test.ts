import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import type { WorkflowNode } from '../domain/types.js';
import { WorkUnitDispatcher } from './work-unit-dispatcher.js';

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
});
