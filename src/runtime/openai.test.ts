import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { HttpOpenAIClient } from './openai.js';

const agent = {
  id: 'hosted-agent', version: 1, name: 'Hosted', purpose: 'test', instructions: 'Be concise.', skills: [], tools: [],
  model: { provider: 'openai', model: 'gpt-5', secretRef: 'connections/openai' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: ['openai'], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 0.1, maxDurationMs: 1_000, maxTokens: 32 },
  termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('HttpOpenAIClient', () => {
  it('calls Responses with server-side Vault credentials and normalizes output', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_1', model: 'gpt-5', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 4, output_tokens: 2 },
    }), { status: 200, headers: { 'x-request-id': 'req_1' } }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('secret-key') };
    const result = await new HttpOpenAIClient({ baseUrl: 'https://api.openai.test/v1', fetcher, secretBroker }).chat({ agent, goal: 'Do it', traceId: 'trace-1', signal: new AbortController().signal });
    expect(result).toEqual({ content: 'done', model: 'gpt-5', promptTokens: 4, completionTokens: 2, requestId: 'req_1' });
    expect(secretBroker.get).toHaveBeenCalledWith('connections/openai');
    expect(String(fetcher.mock.calls[0]?.[1]?.headers)).not.toContain('secret-key');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'gpt-5', store: false });
  });

  it('normalizes function calls without executing undeclared tools', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'call_1', name: 'repo.check', arguments: '{"command":"npm test"}' }] }), { status: 200 }));
    const result = await new HttpOpenAIClient({ apiKey: 'key', fetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5' } }, goal: 'Use a tool', signal: new AbortController().signal });
    expect(result.toolCalls).toEqual([{ callId: 'call_1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
  });
});
