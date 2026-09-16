import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { HttpOpenAIClient } from './openai.js';

describe('OpenAI opt-in smoke test', () => {
  it.skipIf(process.env.OPENAI_SMOKE !== '1')('completes one real Responses API request when explicitly enabled', async () => {
    const agent = structuredClone(seedWorkflow.agents[0]);
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: process.env.OPENAI_MODEL ?? 'gpt-5-mini' };
    const result = await new HttpOpenAIClient({ apiKey: process.env.OPENAI_API_KEY }).chat({
      agent,
      goal: 'Reply with the single word OK.',
      signal: new AbortController().signal,
    });
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.model).toBeTruthy();
  });
});
