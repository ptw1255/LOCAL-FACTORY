import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { JevClient } from './jev.js';

const agent = {
  id: 'jev-operator', version: 1, name: 'Jev', purpose: 'Control the workflow.', instructions: 'Return a typed control decision.', skills: [], tools: [],
  model: { provider: 'jev', model: 'jev-control', secretRef: 'connections/typesafe-ai' }, inputSchema: {}, outputSchema: { type: 'object' },
  boundaries: { allowedConnections: ['jev'], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 1, maxDurationMs: 1_000, maxTokens: 64 },
  termination: { successConditions: ['decision'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('JevClient', () => {
  it('uses the OpenAI-compatible transport with a distinct provider and Vault secret reference', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'jev-1', model: 'jev-control', choices: [{ message: { content: '{"decision":"continue"}' }, finish_reason: 'stop' }] }), { status: 200 }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('jev-secret') };
    const result = await new JevClient({ fetcher, secretBroker }).chat({ agent, goal: 'Check context', signal: new AbortController().signal, traceId: 'trace-jev' });
    expect(result.content).toContain('continue');
    expect(secretBroker.get).toHaveBeenCalledWith('connections/typesafe-ai');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/chat/completions');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer jev-secret', 'x-client-request-id': 'trace-jev' }));
  });
});
