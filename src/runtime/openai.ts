import type { AgentDefinition } from '../domain/types.js';
import type { SecretBroker } from '../connections/secret-broker.js';

export interface OpenAIModelResult {
  content: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  requestId?: string;
  toolCalls?: Array<{ callId: string; name: string; arguments: string }>;
}

export interface OpenAIClient {
  chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string }): Promise<OpenAIModelResult>;
}

export interface OpenAIClientOptions {
  baseUrl?: string;
  apiKey?: string;
  secretBroker?: SecretBroker;
  fetcher?: typeof fetch;
}

/** Minimal server-side Responses API adapter; credentials never enter workflow state. */
export class HttpOpenAIClient implements OpenAIClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly secretBroker?: SecretBroker;
  private readonly fetcher: typeof fetch;

  public constructor(options: OpenAIClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.secretBroker = options.secretBroker;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string }): Promise<OpenAIModelResult> {
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`OpenAI agent "${input.agent.id}" must declare model.model.`);
    const apiKey = await this.resolveApiKey(input.agent);
    const response = await this.fetcher(`${input.agent.model.endpoint ?? this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(input.traceId === undefined ? {} : { 'x-client-request-id': input.traceId }),
      },
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.agent.limits.maxDurationMs)]),
      body: JSON.stringify({
        model,
        store: false,
        stream: input.agent.model.streaming === true,
        input: [
          { role: 'developer', content: input.agent.instructions },
          { role: 'user', content: input.goal },
        ],
        ...(input.agent.limits.maxTokens === undefined ? {} : { max_output_tokens: input.agent.limits.maxTokens }),
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`OpenAI Responses request failed with status ${response.status}${detail === '' ? '.' : `: ${detail}`}`);
    }
    if (input.agent.model.streaming === true) return this.parseStream(response, model);
    const body = await response.json() as {
      model?: unknown;
      output?: Array<{ type?: unknown; text?: unknown; content?: Array<{ type?: unknown; text?: unknown }>; call_id?: unknown; name?: unknown; arguments?: unknown }>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const text = (body.output ?? []).flatMap((item) => {
      if (item.type === 'message') return (item.content ?? []).flatMap((part) => part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []);
      return item.type === 'output_text' && typeof item.text === 'string' ? [item.text] : [];
    }).join('');
    const toolCalls = (body.output ?? []).flatMap((item) => item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string'
      ? [{ callId: item.call_id, name: item.name, arguments: item.arguments }]
      : []);
    return {
      content: text,
      model: typeof body.model === 'string' ? body.model : model,
      ...(typeof body.usage?.input_tokens === 'number' ? { promptTokens: body.usage.input_tokens } : {}),
      ...(typeof body.usage?.output_tokens === 'number' ? { completionTokens: body.usage.output_tokens } : {}),
      ...(response.headers.get('x-request-id') === null ? {} : { requestId: response.headers.get('x-request-id')! }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
  }

  private async parseStream(response: Response, fallbackModel: string): Promise<OpenAIModelResult> {
    if (response.body === null) throw new Error('OpenAI streaming response did not include a body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = fallbackModel;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const consume = (chunk: string): void => {
      buffer += chunk;
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (data === undefined || data === '[DONE]') continue;
        let event: { type?: unknown; delta?: unknown; response?: { model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } };
        try { event = JSON.parse(data) as typeof event; } catch { continue; }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') content += event.delta;
        if (typeof event.response?.model === 'string') model = event.response.model;
        if (typeof event.response?.usage?.input_tokens === 'number') promptTokens = event.response.usage.input_tokens;
        if (typeof event.response?.usage?.output_tokens === 'number') completionTokens = event.response.usage.output_tokens;
      }
    };
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      consume(decoder.decode(next.value, { stream: true }));
    }
    consume(decoder.decode());
    return { content, model, ...(promptTokens === undefined ? {} : { promptTokens }), ...(completionTokens === undefined ? {} : { completionTokens }), ...(response.headers.get('x-request-id') === null ? {} : { requestId: response.headers.get('x-request-id')! }) };
  }

  private async resolveApiKey(agent: AgentDefinition): Promise<string> {
    if (agent.model.secretRef !== undefined) {
      if (this.secretBroker === undefined) throw new Error('A configured Vault secret broker is required for the OpenAI connection.');
      return this.secretBroker.get(agent.model.secretRef);
    }
    if (this.apiKey === undefined || this.apiKey.trim() === '') throw new Error('OpenAI credentials are not configured.');
    return this.apiKey;
  }
}
