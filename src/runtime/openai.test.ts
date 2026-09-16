import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { HttpOpenAIClient, OpenAIProviderError } from './openai.js';

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
      id: 'resp_1', model: 'gpt-5', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }], usage: { input_tokens: 4, output_tokens: 2 },
    }), { status: 200, headers: { 'x-request-id': 'req_1' } }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('secret-key') };
    const result = await new HttpOpenAIClient({ baseUrl: 'https://api.openai.test/v1', fetcher, secretBroker }).chat({ agent: { ...agent, model: { ...agent.model, pricing: { promptPer1kUsd: 1, completionPer1kUsd: 2 } } }, goal: 'Do it', traceId: 'trace-1', signal: new AbortController().signal });
    expect(result).toEqual(expect.objectContaining({ content: 'done', model: 'gpt-5', promptTokens: 4, completionTokens: 2, estimatedCostUsd: 0.008, finishReason: 'completed', requestId: 'req_1' }));
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(new HttpOpenAIClient({ apiKey: 'key' }).capabilities).toEqual(expect.arrayContaining(['streaming', 'tools', 'request_ids']));
    expect(secretBroker.get).toHaveBeenCalledWith('connections/openai');
    expect(String(fetcher.mock.calls[0]?.[1]?.headers)).not.toContain('secret-key');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'gpt-5', store: false });
  });

  it('declares creator-approved tools in the Responses request without executing them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ model: 'gpt-5', status: 'completed', output: [] }), { status: 200 }));
    await new HttpOpenAIClient({ apiKey: 'key', fetcher }).chat({
      agent: { ...agent, tools: ['repo.check', 'repo.check'], model: { provider: 'openai', model: 'gpt-5' } },
      goal: 'Use the declared tool',
      signal: new AbortController().signal,
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { tools?: Array<Record<string, unknown>> };
    expect(body.tools).toEqual([{ type: 'function', name: 'repo.check', description: 'Declared workflow tool: repo.check', parameters: { type: 'object', additionalProperties: true } }]);
  });

  it('normalizes function calls without executing undeclared tools', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'call_1', name: 'repo.check', arguments: '{"command":"npm test"}' }] }), { status: 200 }));
    const result = await new HttpOpenAIClient({ apiKey: 'key', fetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5' } }, goal: 'Use a tool', signal: new AbortController().signal });
    expect(result.toolCalls).toEqual([{ callId: 'call_1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
  });

  it('normalizes streamed Responses output and usage metadata', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hel'));
        controller.enqueue(encoder.encode('lo"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"model":"gpt-5-mini","usage":{"input_tokens":3,"output_tokens":2}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-stream' },
    }));
    const result = await new HttpOpenAIClient({ apiKey: 'key', fetcher }).chat({
      agent: { ...agent, model: { provider: 'openai', model: 'gpt-5', streaming: true } },
      goal: 'Stream it',
      signal: new AbortController().signal,
    });
    expect(result).toEqual(expect.objectContaining({ content: 'hello', model: 'gpt-5-mini', promptTokens: 3, completionTokens: 2, requestId: 'req-stream' }));
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true });
  });

  it('classifies incomplete and refused streaming responses', async () => {
    const encoder = new TextEncoder();
    const stream = (payload: string) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); },
    });
    const incompleteFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), { status: 200 }));
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: incompleteFetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5', streaming: true } }, goal: 'incomplete', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'incomplete' });
    const refusalFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream('data: {"type":"response.refusal.delta","delta":"no"}\n\ndata: {"type":"response.completed"}\n\n'), { status: 200 }));
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: refusalFetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5', streaming: true } }, goal: 'refusal', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'refusal', retryable: false });
  });

  it('normalizes streamed function-call arguments into tool calls', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"repo.check"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"command\\":\\"npm "}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.function_call_arguments.done","item_id":"item_1","arguments":"{\\"command\\":\\"npm test\\"}"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }));
    const result = await new HttpOpenAIClient({ apiKey: 'key', fetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5', streaming: true } }, goal: 'tool', signal: new AbortController().signal });
    expect(result.toolCalls).toEqual([{ callId: 'call_1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
  });

  it('classifies provider failures without exposing credentials', async () => {
    const configuredAgent = { ...agent, model: { provider: 'openai', model: 'gpt-5' } };
    const cases = [
      [401, 'authentication'],
      [429, 'rate_limited'],
      [503, 'server'],
      [400, 'request'],
    ] as const;
    for (const [status, code] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('provider detail', { status }));
      const error = await new HttpOpenAIClient({ apiKey: 'secret-key', fetcher }).chat({ agent: configuredAgent, goal: 'fail', signal: new AbortController().signal }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenAIProviderError);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain('secret-key');
    }
    const leaking = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-key was rejected', { status: 400 }));
    const redacted = await new HttpOpenAIClient({ apiKey: 'secret-key', fetcher: leaking }).chat({ agent: configuredAgent, goal: 'redact', signal: new AbortController().signal }).catch((caught: unknown) => caught);
    expect(String(redacted)).not.toContain('secret-key');
  });

  it('classifies incomplete JSON responses and HTTP timeouts', async () => {
    const incompleteFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete', output: [] }), { status: 200 }));
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: incompleteFetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5' } }, goal: 'incomplete', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'incomplete', retryable: true });
    const timeoutFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('deadline', { status: 408 }));
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: timeoutFetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5' } }, goal: 'timeout', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'timeout', status: 408 });
  });

  it('retries transient provider failures within a bounded budget', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: 'gpt-5', status: 'completed', output: [{ type: 'output_text', text: 'recovered' }] }), { status: 200 }));
    const result = await new HttpOpenAIClient({ apiKey: 'key', fetcher }).chat({ agent: { ...agent, model: { provider: 'openai', model: 'gpt-5' } }, goal: 'retry', signal: new AbortController().signal });
    expect(result.content).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('classifies cancellation, timeout, and connection failures', async () => {
    const configuredAgent = { ...agent, model: { provider: 'openai', model: 'gpt-5' } };
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: vi.fn() }).chat({ agent: configuredAgent, goal: 'cancel', signal: cancelled.signal })).rejects.toMatchObject({ code: 'cancelled', retryable: false });

    const timeoutFetcher = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error('deadline'), { name: 'TimeoutError' }));
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: timeoutFetcher }).chat({ agent: configuredAgent, goal: 'timeout', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'timeout' });

    const connectionFetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(new HttpOpenAIClient({ apiKey: 'key', fetcher: connectionFetcher }).chat({ agent: configuredAgent, goal: 'offline', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'connection' });
  });
});
