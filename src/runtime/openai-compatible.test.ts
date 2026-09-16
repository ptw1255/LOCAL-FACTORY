import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { OpenAIProviderError } from './openai.js';
import { OpenAICompatibleClient } from './openai-compatible.js';

const agent = {
  id: 'local-agent', version: 1, name: 'Local', purpose: 'test', instructions: 'Be concise.', skills: [], tools: [],
  model: { provider: 'lmstudio', model: 'qwen2.5-coder-7b', secretRef: 'connections/local' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: ['local'], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 0.1, maxDurationMs: 1_000, maxTokens: 32 },
  termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('OpenAICompatibleClient', () => {
  it('normalizes chat completions, usage, tools, and Vault credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-1', model: 'qwen2.5-coder-7b', choices: [{ finish_reason: 'tool_calls', message: {
        content: 'working', tool_calls: [{ id: 'call-1', function: { name: 'repo.check', arguments: '{"command":"npm test"}' } }],
      } }], usage: { prompt_tokens: 4, completion_tokens: 2 },
    }), { status: 200 }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('local-secret') };
    const result = await new OpenAICompatibleClient({ baseUrl: 'http://lmstudio.test/v1', fetcher, secretBroker, provider: 'lmstudio' }).chat({
      agent: { ...agent, tools: ['repo.check'], model: { ...agent.model, pricing: { promptPer1kUsd: 1, completionPer1kUsd: 2 } } }, goal: 'Do it', traceId: 'trace-1', signal: new AbortController().signal,
    });
    expect(result).toEqual(expect.objectContaining({ content: 'working', model: 'qwen2.5-coder-7b', requestId: 'chatcmpl-1', promptTokens: 4, completionTokens: 2, estimatedCostUsd: 0.008 }));
    expect(result.toolCalls).toEqual([{ callId: 'call-1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
    expect(secretBroker.get).toHaveBeenCalledWith('connections/local');
    expect(fetcher).toHaveBeenCalledWith('http://lmstudio.test/v1/chat/completions', expect.anything());
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { messages: unknown[]; tools: unknown[] };
    expect(body.messages).toEqual([{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Do it' }]);
    expect(body.tools).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[1]?.headers)).not.toContain('local-secret');
  });

  it('supports OpenAI-compatible SSE streaming and tool argument deltas', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const event = (value: unknown): void => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        event({ id: 'chatcmpl-stream', model: 'local', choices: [{ delta: { content: 'hel' } }] });
        event({ choices: [{ delta: { content: 'lo', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'repo.check', arguments: '{"command":"npm ' } }] } }] });
        event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'test"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const result = await new OpenAICompatibleClient({ apiKey: '', fetcher, provider: 'lmstudio' }).chat({
      agent: { ...agent, model: { provider: 'lmstudio', model: 'local', streaming: true } }, goal: 'Stream it', signal: new AbortController().signal,
    });
    expect(result).toEqual(expect.objectContaining({ content: 'hello', model: 'local', promptTokens: 3, completionTokens: 2, finishReason: 'tool_calls' }));
    expect(result.toolCalls).toEqual([{ callId: 'call-1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('redacts keys from provider errors and retries transient responses', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('local-secret is invalid', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok', model: 'local', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { status: 200 }));
    const result = await new OpenAICompatibleClient({ apiKey: 'local-secret', fetcher, provider: 'lmstudio' }).chat({
      agent: { ...agent, model: { provider: 'lmstudio', model: 'local' } }, goal: 'retry', signal: new AbortController().signal,
    });
    expect(result.content).toBe('done');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('local-secret rejected', { status: 401 }));
    const error = await new OpenAICompatibleClient({ apiKey: 'local-secret', fetcher: denied, provider: 'lmstudio' }).chat({
      agent: { ...agent, model: { provider: 'lmstudio', model: 'local' } }, goal: 'fail', signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAIProviderError);
    expect(error).toMatchObject({ code: 'authentication', status: 401 });
    expect(String(error)).not.toContain('local-secret');
  });
});
