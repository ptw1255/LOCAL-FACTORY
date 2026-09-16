import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { OpenAIProviderError } from './openai.js';
import { OpenAISDKClient } from './openai-sdk.js';

const agent = {
  id: 'sdk-agent', version: 1, name: 'SDK agent', purpose: 'test', instructions: 'Be concise.', skills: [], tools: [],
  model: { provider: 'openai', model: 'gpt-5', secretRef: 'connections/openai' }, inputSchema: {}, outputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false },
  boundaries: { allowedConnections: ['openai'], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 0.1, maxDurationMs: 1_000, maxTokens: 32 },
  termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('OpenAISDKClient', () => {
  it('uses the official Responses SDK with Vault credentials and normalized output', async () => {
    const create = vi.fn().mockReturnValue({ withResponse: async () => ({
      data: { model: 'gpt-5', status: 'completed', output_text: '{"result":"done"}', usage: { input_tokens: 4, output_tokens: 2 } },
      request_id: 'req-sdk',
    }) });
    const factory = vi.fn(() => ({ responses: { create } }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('secret-key') };
    const result = await new OpenAISDKClient({ baseUrl: 'https://api.openai.test/v1', secretBroker, clientFactory: factory }).chat({ agent, goal: 'Do it', traceId: 'trace-sdk', signal: new AbortController().signal });
    expect(result).toEqual(expect.objectContaining({ content: '{"result":"done"}', model: 'gpt-5', promptTokens: 4, completionTokens: 2, requestId: 'req-sdk' }));
    expect(secretBroker.get).toHaveBeenCalledWith('connections/openai');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'secret-key', maxRetries: 0, baseURL: 'https://api.openai.test/v1' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5', store: false, stream: false, text: expect.objectContaining({ format: expect.objectContaining({ type: 'json_schema' }) }) }), expect.objectContaining({ signal: expect.any(AbortSignal), headers: { 'x-client-request-id': 'trace-sdk' } }));
  });

  it('passes declared tools to the official Responses SDK', async () => {
    const create = vi.fn().mockReturnValue({ withResponse: async () => ({ data: { model: 'gpt-5', status: 'completed', output_text: 'done' }, request_id: 'req-tools' }) });
    await new OpenAISDKClient({ apiKey: 'key', clientFactory: () => ({ responses: { create } }) }).chat({
      agent: { ...agent, tools: ['repo.check'], model: { provider: 'openai', model: 'gpt-5' } },
      goal: 'Use a tool',
      signal: new AbortController().signal,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tools: [{ type: 'function', name: 'repo.check', description: 'Declared workflow tool: repo.check', parameters: { type: 'object', additionalProperties: true } }] }), expect.any(Object));
  });

  it('normalizes SDK streaming tool calls and typed provider errors', async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.output_item.added', item: { id: 'item-1', type: 'function_call', call_id: 'call-1', name: 'repo.check' } };
        yield { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"command":"npm ' };
        yield { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: 'test"}' };
        yield { type: 'response.completed', response: { model: 'gpt-5-mini', usage: { input_tokens: 3, output_tokens: 2 } } };
      },
    };
    const create = vi.fn().mockReturnValue({ withResponse: async () => ({ data: stream, request_id: 'req-stream-sdk' }) });
    const result = await new OpenAISDKClient({ apiKey: 'key', clientFactory: () => ({ responses: { create } }) }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5', streaming: true } }, goal: 'Use tool', signal: new AbortController().signal });
    expect(result.toolCalls).toEqual([{ callId: 'call-1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
    expect(result.requestId).toBe('req-stream-sdk');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), expect.any(Object));

    const unauthorized = new OpenAISDKClient({ apiKey: 'secret-key', clientFactory: () => ({ responses: { create: () => ({ withResponse: async () => { throw new Error('secret-key rejected'); } }) } }) });
    const error = await unauthorized.chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5' } }, goal: 'fail', signal: new AbortController().signal }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAIProviderError);
    expect(String(error)).not.toContain('secret-key');
  });
});
