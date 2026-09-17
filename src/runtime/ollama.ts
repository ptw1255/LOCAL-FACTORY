import type { AgentDefinition } from '../domain/types.js';

export interface OllamaClient {
  ensureModel(input: { agent: AgentDefinition; signal: AbortSignal }): Promise<void>;
  chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string }): Promise<OllamaModelResult>;
}

export interface OllamaModelResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  model: string;
  requestId?: string;
}

export interface OllamaClientOptions { baseUrl?: string; fetcher?: typeof fetch }

/** Minimal native Ollama adapter for local development. */
export class HttpOllamaClient implements OllamaClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly readyModels = new Set<string>();
  public constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }
  public async chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string }): Promise<OllamaModelResult> {
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`Ollama agent "${input.agent.id}" must declare model.model.`);
    await this.ensureModel(input);
    const response = await this.fetcher(`${input.agent.model.endpoint ?? this.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(input.traceId === undefined ? {} : { 'x-client-request-id': input.traceId }) },
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.agent.limits.maxDurationMs)]),
      body: JSON.stringify({ model, stream: false, messages: [
        { role: 'system', content: input.agent.instructions }, { role: 'user', content: input.goal },
      ], ...(input.agent.limits.maxTokens === undefined ? {} : { options: { num_predict: input.agent.limits.maxTokens } }) }),
    });
    if (!response.ok) throw new Error(`Ollama request failed with status ${response.status}.`);
    const body = await response.json() as { message?: { content?: unknown }; prompt_eval_count?: unknown; eval_count?: unknown; model?: unknown };
    if (typeof body.message?.content !== 'string') throw new Error('Ollama response did not contain message.content.');
    return {
      content: body.message.content, model: typeof body.model === 'string' ? body.model : model,
      ...(typeof body.prompt_eval_count === 'number' ? { promptTokens: body.prompt_eval_count } : {}),
      ...(typeof body.eval_count === 'number' ? { completionTokens: body.eval_count } : {}),
    };
  }

  public async ensureModel(input: { agent: AgentDefinition; signal: AbortSignal }): Promise<void> {
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`Ollama agent "${input.agent.id}" must declare model.model.`);
    if (input.agent.model.provisioning?.mode !== 'pull-on-start') return;
    if (this.readyModels.has(`${input.agent.model.endpoint ?? this.baseUrl}/${model}`)) return;
    const endpoint = input.agent.model.endpoint ?? this.baseUrl;
    const timeoutMs = input.agent.model.provisioning.timeoutMs ?? input.agent.limits.maxDurationMs;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
    const tags = await this.fetcher(`${endpoint}/api/tags`, { signal });
    if (!tags.ok) throw new Error(`Ollama model discovery failed with status ${tags.status}.`);
    const body = await tags.json() as { models?: Array<{ name?: unknown; digest?: unknown }> };
    const installed = body.models?.find((candidate) => candidate.name === model);
    if (installed !== undefined) {
      const expected = input.agent.model.provisioning.digest;
      if (expected !== undefined && installed.digest !== expected) {
        throw new Error(`Ollama model "${model}" digest does not match the declared digest.`);
      }
      this.readyModels.add(`${endpoint}/${model}`);
      return;
    }
    const pulled = await this.fetcher(`${endpoint}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ model, stream: false }),
    });
    if (!pulled.ok) throw new Error(`Ollama model pull failed with status ${pulled.status}.`);
    this.readyModels.add(`${endpoint}/${model}`);
  }

  public async provision(agents: AgentDefinition[], signal = new AbortController().signal): Promise<void> {
    for (const agent of agents.filter((candidate) => candidate.model.provider?.toLowerCase() === 'ollama')) {
      await this.ensureModel({ agent, signal });
    }
  }
}
