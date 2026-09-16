import type { AgentDefinition } from '../domain/types.js';
import type { SecretBroker } from '../connections/secret-broker.js';
import { OpenAIProviderError, type OpenAIClient, type OpenAIModelResult } from './openai.js';

export interface AnthropicClientOptions {
  baseUrl?: string;
  apiKey?: string;
  secretBroker?: SecretBroker;
  fetcher?: typeof fetch;
}

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface AnthropicResponse {
  id?: unknown;
  model?: unknown;
  stop_reason?: unknown;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** Native Anthropic Messages adapter behind the provider-neutral agent contract. */
export class AnthropicClient implements OpenAIClient {
  public readonly provider = 'anthropic' as const;
  public readonly capabilities = ['text', 'streaming', 'tools', 'usage', 'request_ids'] as const;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly secretBroker?: SecretBroker;
  private readonly fetcher: typeof fetch;

  public constructor(options: AnthropicClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.secretBroker = options.secretBroker;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string }): Promise<OpenAIModelResult> {
    const startedAt = Date.now();
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`Anthropic agent "${input.agent.id}" must declare model.model.`);
    const apiKey = await this.resolveApiKey(input.agent);
    if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'Anthropic request was cancelled.', { retryable: false });
    const body = {
      model,
      max_tokens: input.agent.limits.maxTokens ?? 4_096,
      system: input.agent.instructions,
      messages: [{ role: 'user', content: input.goal }],
      ...(input.agent.model.streaming === true ? { stream: true } : {}),
      ...(input.agent.tools.length === 0 ? {} : { tools: input.agent.tools.filter((name, index, values) => values.indexOf(name) === index).map((name) => ({ name, description: `Declared workflow tool: ${name}`, input_schema: { type: 'object', additionalProperties: true } })) }),
    } satisfies Record<string, unknown>;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.agent.limits.maxDurationMs)]);
    let response: Response | undefined;
    let lastTransient: OpenAIProviderError | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await this.fetcher(this.messagesEndpoint(input.agent), {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            ...(input.traceId === undefined ? {} : { 'x-client-request-id': input.traceId }),
          },
          signal,
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'Anthropic request was cancelled.', { retryable: false });
        lastTransient = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? new OpenAIProviderError('timeout', 'Anthropic request timed out.')
          : new OpenAIProviderError('connection', 'Anthropic request could not connect to the provider.');
      }
      if (response?.ok === true) break;
      if (response !== undefined) {
        const code = response.status === 401 || response.status === 403
          ? 'authentication'
          : response.status === 429
            ? 'rate_limited'
            : response.status === 408
              ? 'timeout'
              : response.status >= 500 ? 'server' : 'request';
        const detail = (await response.clone().text()).replaceAll(apiKey, '[REDACTED]').slice(0, 500);
        lastTransient = new OpenAIProviderError(code, `Anthropic Messages request failed with status ${response.status}${detail === '' ? '.' : `: ${detail}`}`, { status: response.status });
      }
      const transient = lastTransient ?? new OpenAIProviderError('connection', 'Anthropic request could not connect to the provider.');
      if (!transient.retryable || attempt >= 3) throw transient;
      await this.delay(250 * attempt, signal);
      response = undefined;
    }
    if (response === undefined) throw lastTransient ?? new OpenAIProviderError('connection', 'Anthropic request could not connect to the provider.');
    if (input.agent.model.streaming === true) return { ...await this.parseStream(response, model, input.agent.model.pricing), latencyMs: Date.now() - startedAt };
    let parsed: AnthropicResponse;
    try { parsed = await response.json() as AnthropicResponse; } catch { throw new OpenAIProviderError('incomplete', 'Anthropic response was not valid JSON.', { retryable: true }); }
    return { ...this.normalize(parsed, model, input.agent.model.pricing, typeof parsed.id === 'string' ? parsed.id : response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? undefined), latencyMs: Date.now() - startedAt };
  }

  private messagesEndpoint(agent: AgentDefinition): string {
    const endpoint = (agent.model.endpoint ?? this.baseUrl).replace(/\/$/, '');
    if (endpoint.endsWith('/messages')) return endpoint;
    return endpoint.endsWith('/v1') ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
  }

  private normalize(value: AnthropicResponse, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }, requestId?: string): OpenAIModelResult {
    const content = (value.content ?? []).flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('');
    const toolCalls = (value.content ?? []).flatMap((block, index) => {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') return [];
      return [{ callId: typeof block.id === 'string' ? block.id : `anthropic-call-${index + 1}`, name: block.name, arguments: JSON.stringify(block.input ?? {}) }];
    });
    const promptTokens = typeof value.usage?.input_tokens === 'number' ? value.usage.input_tokens : undefined;
    const completionTokens = typeof value.usage?.output_tokens === 'number' ? value.usage.output_tokens : undefined;
    return {
      content,
      model: typeof value.model === 'string' ? value.model : fallbackModel,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(typeof value.stop_reason === 'string' ? { finishReason: value.stop_reason } : {}),
      ...(requestId === undefined ? {} : { requestId }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}),
    };
  }

  private async parseStream(response: Response, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }): Promise<OpenAIModelResult> {
    if (response.body === null) throw new OpenAIProviderError('incomplete', 'Anthropic streaming response did not include a body.', { retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = fallbackModel;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let requestId: string | undefined;
    let completed = false;
    const tools = new Map<string, { callId: string; name: string; arguments: string }>();
    const consume = (chunk: string): void => {
      buffer += chunk;
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (data === undefined) continue;
        let event: { type?: unknown; message?: AnthropicResponse; index?: unknown; content_block?: AnthropicContentBlock; delta?: { type?: unknown; text?: unknown; partial_json?: unknown; stop_reason?: unknown; usage?: { output_tokens?: unknown } } };
        try { event = JSON.parse(data) as typeof event; } catch { continue; }
        if (event.type === 'message_start') {
          if (typeof event.message?.id === 'string') requestId = event.message.id;
          if (typeof event.message?.model === 'string') model = event.message.model;
          if (typeof event.message?.usage?.input_tokens === 'number') promptTokens = event.message.usage.input_tokens;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && typeof event.content_block.id === 'string' && typeof event.content_block.name === 'string') {
          tools.set(String(event.index ?? tools.size), { callId: event.content_block.id, name: event.content_block.name, arguments: '' });
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') content += event.delta.text;
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
          const tool = tools.get(String(event.index));
          if (tool !== undefined) tool.arguments += event.delta.partial_json;
        }
        if (event.type === 'message_delta') {
          if (typeof event.delta?.stop_reason === 'string') finishReason = event.delta.stop_reason;
          if (typeof event.delta?.usage?.output_tokens === 'number') completionTokens = event.delta.usage.output_tokens;
        }
        if (event.type === 'message_stop') completed = true;
      }
    };
    while (true) { const next = await reader.read(); if (next.done) break; consume(decoder.decode(next.value, { stream: true })); }
    consume(decoder.decode());
    if (!completed) throw new OpenAIProviderError('incomplete', 'Anthropic streaming response ended before completion.', { retryable: true });
    return { content, model, ...(promptTokens === undefined ? {} : { promptTokens }), ...(completionTokens === undefined ? {} : { completionTokens }), ...(finishReason === undefined ? {} : { finishReason }), ...(requestId === undefined ? {} : { requestId }), ...(tools.size === 0 ? {} : { toolCalls: [...tools.values()] }), ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}) };
  }

  private async resolveApiKey(agent: AgentDefinition): Promise<string> {
    if (agent.model.secretRef !== undefined) {
      if (this.secretBroker === undefined) throw new Error('A configured Vault secret broker is required for the Anthropic connection.');
      return this.secretBroker.get(agent.model.secretRef);
    }
    if (this.apiKey === undefined || this.apiKey.trim() === '') throw new OpenAIProviderError('authentication', 'Anthropic credentials are not configured.', { retryable: false });
    return this.apiKey;
  }

  private async delay(durationMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, durationMs); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  }
}
