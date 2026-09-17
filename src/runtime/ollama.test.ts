import { describe, expect, it, vi } from 'vitest';
import { HttpOllamaClient } from './ollama.js';
import type { AgentDefinition } from '../domain/types.js';

const agent = {
  id: 'local-agent', version: 1, name: 'Local', purpose: 'test', instructions: 'Be concise.', skills: [], tools: [],
  model: { provider: 'ollama', model: 'llama3.2' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: [], allowedRepositories: [], protectedPaths: [], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 0, maxDurationMs: 1_000, maxTokens: 32 },
  termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

describe('HttpOllamaClient', () => {
  it('posts a bounded chat request and parses the response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      model: 'llama3.2', message: { content: 'done' }, prompt_eval_count: 4, eval_count: 2,
    }), { status: 200 }));
    const result = await new HttpOllamaClient({ baseUrl: 'http://ollama:11434', fetcher }).chat({ agent, goal: 'Do it', traceId: 'trace-ollama', signal: new AbortController().signal });
    expect(result).toEqual({ content: 'done', model: 'llama3.2', promptTokens: 4, completionTokens: 2 });
    expect(fetcher).toHaveBeenCalledWith('http://ollama:11434/api/chat', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-client-request-id': 'trace-ollama' }) }));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'llama3.2', stream: false });
  });

  it('pulls a missing model when pull-on-start is declared', async () => {
    const provisioned = { ...agent, model: { provider: 'ollama', model: 'llama3.2', provisioning: { mode: 'pull-on-start' as const } } } satisfies AgentDefinition;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await new HttpOllamaClient({ baseUrl: 'http://ollama:11434', fetcher }).ensureModel({ agent: provisioned, signal: new AbortController().signal });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://ollama:11434/api/tags', 'http://ollama:11434/api/pull']);
  });
});
