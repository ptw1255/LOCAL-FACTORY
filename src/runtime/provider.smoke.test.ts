import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import type { AgentDefinition } from '../domain/types.js';
import { AnthropicClient } from './anthropic.js';
import { GeminiClient } from './gemini.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { HttpOllamaClient } from './ollama.js';

const signal = new AbortController().signal;

function smokeAgent(provider: string, model: string): AgentDefinition {
  const source = seedWorkflow.agents[0];
  if (source === undefined) throw new Error('Seed agent is missing.');
  return {
    ...structuredClone(source),
    model: { provider, model, streaming: false },
    limits: { ...source.limits, maxIterations: 1, maxDurationMs: 30_000, maxTokens: 32 },
  };
}

async function assertCompletion(result: { content: string; model: string }): Promise<void> {
  expect(result.content.length).toBeGreaterThan(0);
  expect(result.model.length).toBeGreaterThan(0);
}

describe('opt-in live provider smoke tests', () => {
  it.skipIf(process.env.ANTHROPIC_SMOKE !== '1')('completes one real Anthropic Messages request', async () => {
    const client = new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY });
    await assertCompletion(await client.chat({
      agent: smokeAgent('anthropic', process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest'),
      goal: 'Reply with the single word OK.',
      signal,
    }));
  }, 45_000);

  it.skipIf(process.env.GEMINI_SMOKE !== '1')('completes one real Gemini generate-content request', async () => {
    const client = new GeminiClient({ apiKey: process.env.GEMINI_API_KEY });
    await assertCompletion(await client.chat({
      agent: smokeAgent('gemini', process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'),
      goal: 'Reply with the single word OK.',
      signal,
    }));
  }, 45_000);

  it.skipIf(process.env.OLLAMA_SMOKE !== '1')('completes one real Ollama request', async () => {
    const client = new HttpOllamaClient({ baseUrl: process.env.OLLAMA_BASE_URL });
    await assertCompletion(await client.chat({
      agent: smokeAgent('ollama', process.env.OLLAMA_MODEL ?? 'llama3.2'),
      goal: 'Reply with the single word OK.',
      signal,
    }));
  }, 45_000);

  it.skipIf(process.env.LOCAL_MODEL_SMOKE !== '1')('completes one real OpenAI-compatible local request', async () => {
    const client = new OpenAICompatibleClient({
      provider: process.env.LOCAL_MODEL_PROVIDER ?? 'openai-compatible',
      baseUrl: process.env.LOCAL_MODEL_BASE_URL,
      apiKey: process.env.LOCAL_MODEL_API_KEY,
    });
    await assertCompletion(await client.chat({
      agent: smokeAgent(client.provider, process.env.LOCAL_MODEL_NAME ?? 'local-model'),
      goal: 'Reply with the single word OK.',
      signal,
    }));
  }, 45_000);
});
