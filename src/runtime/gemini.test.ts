import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../domain/types.js';
import { GeminiClient } from './gemini.js';

const agent = {
  id: 'gemini-agent', version: 1, name: 'Gemini', purpose: 'test', instructions: 'Be concise.', skills: [], tools: ['repo.check'],
  model: { provider: 'gemini', model: 'gemini-2.5-flash', secretRef: 'connections/gemini' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: ['gemini'], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 0.1, maxDurationMs: 1_000, maxTokens: 32 },
  termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('GeminiClient', () => {
  it('normalizes generateContent output and keeps credentials out of the body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      responseId: 'resp-1', modelVersion: 'gemini-2.5-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }, { functionCall: { name: 'repo.check', args: { command: 'npm test' } } }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    }), { status: 200 }));
    const secretBroker = { put: vi.fn(), get: vi.fn().mockResolvedValue('gemini-secret') };
    const result = await new GeminiClient({ baseUrl: 'https://gemini.test', fetcher, secretBroker }).chat({ agent, goal: 'Do it', signal: new AbortController().signal });
    expect(result).toEqual(expect.objectContaining({ content: 'done', model: 'gemini-2.5-flash', requestId: 'resp-1', promptTokens: 4, completionTokens: 2, finishReason: 'STOP' }));
    expect(result.toolCalls).toEqual([{ callId: 'gemini-call-2', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
    expect(fetcher).toHaveBeenCalledWith('https://gemini.test/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-secret', expect.anything());
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('gemini-secret');
  });

  it('normalizes Gemini SSE content, tools, and terminal usage', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const event = (value: unknown): void => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      event({ responseId: 'resp-stream', modelVersion: 'gemini-local', candidates: [{ content: { parts: [{ text: 'hello' }] } }] });
      event({ responseId: 'resp-stream', candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'repo.check', args: { command: 'npm test' } } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
      controller.close();
    } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const result = await new GeminiClient({ apiKey: 'key', fetcher }).chat({ agent: { ...agent, model: { provider: 'gemini', model: 'gemini-local', streaming: true } }, goal: 'Stream', signal: new AbortController().signal });
    expect(result).toEqual(expect.objectContaining({ content: 'hello', model: 'gemini-local', requestId: 'resp-stream', promptTokens: 3, completionTokens: 2, finishReason: 'STOP' }));
    expect(result.toolCalls).toEqual([{ callId: 'gemini-call-1', name: 'repo.check', arguments: '{"command":"npm test"}' }]);
    expect(fetcher.mock.calls[0]?.[0]).toContain(':streamGenerateContent?key=key&alt=sse');
  });
});
