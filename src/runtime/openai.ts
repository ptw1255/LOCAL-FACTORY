import type { AgentDefinition } from '../domain/types.js';
import type { SecretBroker } from '../connections/secret-broker.js';

export interface OpenAIModelResult {
  content: string;
  model: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  finishReason?: string;
  requestId?: string;
  toolCalls?: Array<{ callId: string; name: string; arguments: string }>;
}

export type OpenAICapability = 'text' | 'structured_output' | 'streaming' | 'tools' | 'usage' | 'request_ids';

/** Capabilities guaranteed by the native Responses adapter. */
export const OPENAI_CAPABILITIES: readonly OpenAICapability[] = [
  'text', 'structured_output', 'streaming', 'tools', 'usage', 'request_ids',
];

/**
 * Convert the creator-declared tool names into permissive Responses API
 * function definitions. Tool execution and authorization remain in the
 * runtime; the provider only receives the names and an object-shaped argument
 * contract because the current agent envelope stores tool names, not schemas.
 */
export function openAIToolDefinitions(agent: AgentDefinition): Array<Record<string, unknown>> {
  return [...new Set(agent.tools)].map((name) => ({
    type: 'function',
    name,
    description: `Declared workflow tool: ${name}`,
    parameters: {
      type: 'object',
      additionalProperties: true,
    },
  }));
}

export type OpenAIProviderErrorCode =
  | 'authentication'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'cancelled'
  | 'connection'
  | 'incomplete'
  | 'refusal'
  | 'request';

export class OpenAIProviderError extends Error {
  public readonly code: OpenAIProviderErrorCode;
  public readonly status?: number;
  public readonly retryable: boolean;

  public constructor(code: OpenAIProviderErrorCode, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'OpenAIProviderError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? ['rate_limited', 'server', 'timeout', 'connection'].includes(code);
  }
}

export interface OpenAIClient {
  /** Provider identifier emitted in lifecycle telemetry (for example openai or lmstudio). */
  readonly provider?: string;
  readonly capabilities?: readonly OpenAICapability[];
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
  public readonly provider = 'openai' as const;
  public readonly capabilities = OPENAI_CAPABILITIES;
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
    const startedAt = Date.now();
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`OpenAI agent "${input.agent.id}" must declare model.model.`);
    const apiKey = await this.resolveApiKey(input.agent);
    if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'OpenAI request was cancelled.', { retryable: false });
    const requestBody = JSON.stringify({
      model,
      store: false,
      stream: input.agent.model.streaming === true,
      input: [
        { role: 'developer', content: input.agent.instructions },
        { role: 'user', content: input.goal },
      ],
      ...(input.agent.limits.maxTokens === undefined ? {} : { max_output_tokens: input.agent.limits.maxTokens }),
      ...(input.agent.tools.length === 0 ? {} : { tools: openAIToolDefinitions(input.agent) }),
    });
    const requestSignal = AbortSignal.any([input.signal, AbortSignal.timeout(input.agent.limits.maxDurationMs)]);
    let response: Response | undefined;
    let lastTransient: OpenAIProviderError | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await this.fetcher(`${input.agent.model.endpoint ?? this.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...(input.traceId === undefined ? {} : { 'x-client-request-id': input.traceId }),
          },
          signal: requestSignal,
          body: requestBody,
        });
      } catch (error) {
        if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'OpenAI request was cancelled.', { retryable: false });
        const name = error instanceof Error ? error.name : '';
        lastTransient = name === 'TimeoutError' || name === 'AbortError'
          ? new OpenAIProviderError('timeout', 'OpenAI request timed out.')
          : new OpenAIProviderError('connection', 'OpenAI request could not connect to the provider.');
      }
      if (response?.ok === true) break;
      if (response !== undefined) {
        const code: OpenAIProviderErrorCode = response.status === 401 || response.status === 403
          ? 'authentication'
          : response.status === 429
            ? 'rate_limited'
            : response.status === 408
              ? 'timeout'
            : response.status >= 500 ? 'server' : 'request';
        const detail = (await response.clone().text()).replaceAll(apiKey, '[REDACTED]').slice(0, 500);
        lastTransient = new OpenAIProviderError(code, `OpenAI Responses request failed with status ${response.status}${detail === '' ? '.' : `: ${detail}`}`, { status: response.status });
      }
      const transient = lastTransient ?? new OpenAIProviderError('connection', 'OpenAI request could not connect to the provider.');
      if (transient.retryable !== true || attempt >= 3) throw transient;
      const retryAfterHeader = response?.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader === null || retryAfterHeader === undefined ? undefined : Number(retryAfterHeader) * 1_000;
      await this.delay(Math.min(Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : 250 * attempt, 2_000), requestSignal);
      response = undefined;
    }
    if (response === undefined) throw lastTransient ?? new OpenAIProviderError('connection', 'OpenAI request could not connect to the provider.');
    if (input.agent.model.streaming === true) {
      const result = await this.parseStream(response, model, input.agent.model.pricing);
      return { ...result, latencyMs: Date.now() - startedAt };
    }
    let body: {
      model?: unknown;
      output?: Array<{ type?: unknown; text?: unknown; content?: Array<{ type?: unknown; text?: unknown }>; call_id?: unknown; name?: unknown; arguments?: unknown }>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      status?: unknown;
    };
    try {
      body = await response.json() as typeof body;
    } catch {
      throw new OpenAIProviderError('incomplete', 'OpenAI response was not valid JSON.', { retryable: true });
    }
    if (body.output?.some((item) => item.type === 'refusal')) {
      throw new OpenAIProviderError('refusal', 'OpenAI declined the requested response.', { retryable: false });
    }
    if (body.status === 'incomplete') {
      throw new OpenAIProviderError('incomplete', 'OpenAI response ended before completion.', { retryable: true });
    }
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
      latencyMs: Date.now() - startedAt,
      ...(typeof body.usage?.input_tokens === 'number' ? { promptTokens: body.usage.input_tokens } : {}),
      ...(typeof body.usage?.output_tokens === 'number' ? { completionTokens: body.usage.output_tokens } : {}),
      ...(typeof body.status === 'string' ? { finishReason: body.status } : {}),
      ...(typeof body.usage?.input_tokens === 'number' && typeof body.usage?.output_tokens === 'number' && input.agent.model.pricing !== undefined
        ? { estimatedCostUsd: Number(((body.usage.input_tokens / 1_000) * input.agent.model.pricing.promptPer1kUsd + (body.usage.output_tokens / 1_000) * input.agent.model.pricing.completionPer1kUsd).toFixed(6)) }
        : {}),
      ...(response.headers.get('x-request-id') === null ? {} : { requestId: response.headers.get('x-request-id')! }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
  }

  private async parseStream(response: Response, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }): Promise<OpenAIModelResult> {
    if (response.body === null) throw new OpenAIProviderError('incomplete', 'OpenAI streaming response did not include a body.', { retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = fallbackModel;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let completed = false;
    let refused = false;
    const streamedTools = new Map<string, { callId: string; name: string; arguments: string }>();
    const consume = (chunk: string): void => {
      buffer += chunk;
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (data === undefined || data === '[DONE]') continue;
        let event: { type?: unknown; delta?: unknown; arguments?: unknown; item_id?: unknown; item?: { id?: unknown; type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown }; response?: { model?: unknown; status?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } };
        try { event = JSON.parse(data) as typeof event; } catch { continue; }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') content += event.delta;
        if (event.type === 'response.refusal.delta') refused = true;
        if (event.type === 'response.completed') completed = true;
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && typeof event.item.call_id === 'string' && typeof event.item.name === 'string') {
          const key = typeof event.item.id === 'string' ? event.item.id : event.item.call_id;
          streamedTools.set(key, { callId: event.item.call_id, name: event.item.name, arguments: typeof event.item.arguments === 'string' ? event.item.arguments : '' });
        }
        if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string' && typeof event.item_id === 'string') {
          const tool = streamedTools.get(event.item_id);
          if (tool !== undefined) tool.arguments += event.delta;
        }
        if (event.type === 'response.function_call_arguments.done' && typeof event.item_id === 'string' && typeof event.arguments === 'string') {
          const tool = streamedTools.get(event.item_id);
          if (tool !== undefined) tool.arguments = event.arguments;
        }
        if (typeof event.response?.model === 'string') model = event.response.model;
        if (typeof event.response?.status === 'string') finishReason = event.response.status;
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
    if (refused) throw new OpenAIProviderError('refusal', 'OpenAI declined the requested response.', { retryable: false });
    if (!completed) throw new OpenAIProviderError('incomplete', 'OpenAI streaming response ended before completion.', { retryable: true });
    return {
      content,
      model,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(streamedTools.size === 0 ? {} : { toolCalls: [...streamedTools.values()] }),
      ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}),
      ...(response.headers.get('x-request-id') === null ? {} : { requestId: response.headers.get('x-request-id')! }),
    };
  }

  private async resolveApiKey(agent: AgentDefinition): Promise<string> {
    if (agent.model.secretRef !== undefined) {
      if (this.secretBroker === undefined) throw new Error('A configured Vault secret broker is required for the OpenAI connection.');
      return this.secretBroker.get(agent.model.secretRef);
    }
    if (this.apiKey === undefined || this.apiKey.trim() === '') throw new Error('OpenAI credentials are not configured.');
    return this.apiKey;
  }

  private async delay(durationMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, durationMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
}
