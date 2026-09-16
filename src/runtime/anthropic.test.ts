import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { AnthropicClient } from './anthropic.js';

const agent = {
  id: 'anthropic-agent', version: 1, name: 'Anthropic', purpose: 'test', instructions: 'Be concise.', skills: [], tools: ['repo.check'],
  model: { provider: 'anthropic', model: 'claude-3-5-sonnet', secretRef: 'connections/anthropic' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: ['anthropic'], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 0.1, maxDurationMs: 1_000, maxTokens: 32 },
  termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('AnthropicClient', () => {
  it('normalizes Messages output, tools, usage, and Vault credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_1', model: 'claude-3-5-sonnet', stop_reason: 'tool_use', content: [
        { type: 'text', text: 'working' }, { type: 'tool_use', id: 'tool-1', name: 'repo.check', input: { command: 'npm test' } },
      ], usage: { input_tokens: 4, output_tokens: 2 },
    }), { status: 200 }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('anthropic-secret') };
    const result = await new AnthropicClient({ baseUrl: 'https://anthropic.test', fetcher, secretBroker }).chat({ agent, goal: 'Do it', traceId: 'trace-1', signal: new AbortController().signal });
    expect(result).toEqual(expect.objectContaining({ content: 'working', model: 'claude-3-5-sonnet', requestId: 'msg_1', promptTokens: 4, completionTokens: 2, finishReason: 'tool_use' }));
    expect(result.toolCalls).toEqual([{ callId: 'tool-1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
    expect(secretBroker.get).toHaveBeenCalledWith('connections/anthropic');
    expect(fetcher).toHaveBeenCalledWith('https://anthropic.test/v1/messages', expect.anything());
    const request = fetcher.mock.calls[0]?.[1];
    expect(String(request?.headers)).not.toContain('anthropic-secret');
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: 'claude-3-5-sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'Do it' }] });
  });

  it('normalizes Anthropic streaming text, tool deltas, and terminal usage', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const event = (value: unknown): void => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      event({ type: 'message_start', message: { id: 'msg-stream', model: 'claude-local', usage: { input_tokens: 3 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'repo.check' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } });
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } });
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use', usage: { output_tokens: 2 } } });
      event({ type: 'message_stop' });
      controller.close();
    } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const result = await new AnthropicClient({ apiKey: 'key', fetcher }).chat({ agent: { ...agent, model: { provider: 'anthropic', model: 'claude-local', streaming: true } }, goal: 'Stream', signal: new AbortController().signal });
    expect(result).toEqual(expect.objectContaining({ content: 'done', model: 'claude-local', promptTokens: 3, completionTokens: 2, finishReason: 'tool_use', requestId: 'msg-stream' }));
    expect(result.toolCalls).toEqual([{ callId: 'tool-1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
  });
});
