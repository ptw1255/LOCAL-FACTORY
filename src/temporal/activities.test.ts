import { describe, expect, it } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { WorkUnitTimeoutError } from '../runtime/work-unit-dispatcher.js';
import { executeNodeActivity } from './activities.js';

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
    expect(result).toEqual({ nodeId: 'normalize', result: 'HELLO' });
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
