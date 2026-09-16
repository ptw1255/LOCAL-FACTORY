import type { AgentDefinition } from '../domain/types.js';
import type { SecretBroker } from '../connections/secret-broker.js';
import {
  OPENAI_CAPABILITIES,
  OpenAIProviderError,
  type OpenAIClient,
  type OpenAIModelResult,
} from './openai.js';
import { openAIToolDefinitions } from './openai.js';

/**
 * OpenAI-compatible chat-completions adapter.
 *
 * This is intentionally a small HTTP adapter rather than an SDK dependency:
 * LM Studio, vLLM, LocalAI, and several gateway products expose this contract
 * while differing in their branding and authentication setup. The workflow
 * still declares a provider name and endpoint, while credentials stay behind
 * the SecretBroker boundary.
 */
export interface OpenAICompatibleClientOptions {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  secretBroker?: SecretBroker;
  fetcher?: typeof fetch;
}

type ChatMessage = { role: 'system' | 'user'; content: string };

interface ChatCompletionBody {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
    };
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

interface StreamToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export class OpenAICompatibleClient implements OpenAIClient {
  public readonly provider: string;
  public readonly capabilities = OPENAI_CAPABILITIES;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly secretBroker?: SecretBroker;
  private readonly fetcher: typeof fetch;

  public constructor(options: OpenAICompatibleClientOptions = {}) {
    this.provider = options.provider?.trim() || 'openai-compatible';
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.LM_STUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LM_STUDIO_API_KEY;
    this.secretBroker = options.secretBroker;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string }): Promise<OpenAIModelResult> {
    const startedAt = Date.now();
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`${this.provider} agent "${input.agent.id}" must declare model.model.`);
    const apiKey = await this.resolveApiKey(input.agent);
    if (input.signal.aborted) throw new OpenAIProviderError('cancelled', `${this.provider} request was cancelled.`, { retryable: false });

    const messages: ChatMessage[] = [
      { role: 'system', content: input.agent.instructions },
      { role: 'user', content: input.goal },
    ];
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: input.agent.model.streaming === true,
      ...(input.agent.model.streaming === true ? { stream_options: { include_usage: true } } : {}),
      ...(input.agent.limits.maxTokens === undefined ? {} : { max_tokens: input.agent.limits.maxTokens }),
      ...(input.agent.tools.length === 0 ? {} : { tools: openAIToolDefinitions(input.agent).map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })) }),
      ...(Object.keys(input.agent.outputSchema).length === 0 ? {} : {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: `${input.agent.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_output`,
            strict: true,
            schema: input.agent.outputSchema,
          },
        },
      }),
    };
    const requestSignal = AbortSignal.any([input.signal, AbortSignal.timeout(input.agent.limits.maxDurationMs)]);
    let response: Response | undefined;
    let lastTransient: OpenAIProviderError | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await this.fetcher(this.chatEndpoint(input.agent), {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
            ...(input.traceId === undefined ? {} : { 'x-client-request-id': input.traceId }),
          },
          signal: requestSignal,
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        if (input.signal.aborted) throw new OpenAIProviderError('cancelled', `${this.provider} request was cancelled.`, { retryable: false });
        const name = error instanceof Error ? error.name : '';
        lastTransient = name === 'TimeoutError' || name === 'AbortError'
          ? new OpenAIProviderError('timeout', `${this.provider} request timed out.`)
          : new OpenAIProviderError('connection', `${this.provider} request could not connect to the provider.`);
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
        lastTransient = new OpenAIProviderError(code, `${this.provider} chat request failed with status ${response.status}${detail === '' ? '.' : `: ${detail}`}`, { status: response.status });
      }
      const transient = lastTransient ?? new OpenAIProviderError('connection', `${this.provider} request could not connect to the provider.`);
      if (!transient.retryable || attempt >= 3) throw transient;
      await this.delay(Math.min(250 * attempt, 2_000), requestSignal);
      response = undefined;
    }
    if (response === undefined) throw lastTransient ?? new OpenAIProviderError('connection', `${this.provider} request could not connect to the provider.`);
    if (input.agent.model.streaming === true) {
      return { ...await this.parseStream(response, model, input.agent.model.pricing), latencyMs: Date.now() - startedAt };
    }
    let body: ChatCompletionBody;
    try {
      body = await response.json() as ChatCompletionBody;
    } catch {
      throw new OpenAIProviderError('incomplete', `${this.provider} response was not valid JSON.`, { retryable: true });
    }
    const choice = body.choices?.[0];
    if (choice === undefined) throw new OpenAIProviderError('incomplete', `${this.provider} response did not include a choice.`, { retryable: true });
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    const toolCalls = (choice.message?.tool_calls ?? []).flatMap((call, index) => {
      const name = call.function?.name;
      if (typeof name !== 'string') return [];
      const callId = typeof call.id === 'string' ? call.id : `${this.provider}-call-${index + 1}`;
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {});
      return [{ callId, name, arguments: args }];
    });
    const promptTokens = typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : undefined;
    const completionTokens = typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : undefined;
    return {
      content,
      model: typeof body.model === 'string' ? body.model : model,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(typeof choice.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
      ...(typeof body.id === 'string' ? { requestId: body.id } : response.headers.get('x-request-id') === null ? {} : { requestId: response.headers.get('x-request-id')! }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(promptTokens !== undefined && completionTokens !== undefined && input.agent.model.pricing !== undefined
        ? { estimatedCostUsd: Number(((promptTokens / 1_000) * input.agent.model.pricing.promptPer1kUsd + (completionTokens / 1_000) * input.agent.model.pricing.completionPer1kUsd).toFixed(6)) }
        : {}),
      latencyMs: Date.now() - startedAt,
    };
  }

  private chatEndpoint(agent: AgentDefinition): string {
    const endpoint = (agent.model.endpoint ?? this.baseUrl).replace(/\/$/, '');
    return endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;
  }

  private async parseStream(response: Response, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }): Promise<OpenAIModelResult> {
    if (response.body === null) throw new OpenAIProviderError('incomplete', `${this.provider} streaming response did not include a body.`, { retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = fallbackModel;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let completed = false;
    const tools = new Map<number, StreamToolCall>();
    const consume = (chunk: string): void => {
      buffer += chunk;
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (data === undefined) continue;
        if (data === '[DONE]') { completed = true; continue; }
        let event: { id?: unknown; model?: unknown; choices?: Array<{ finish_reason?: unknown; delta?: { content?: unknown; tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }> } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        try { event = JSON.parse(data) as typeof event; } catch { continue; }
        if (typeof event.model === 'string') model = event.model;
        const choice = event.choices?.[0];
        if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        if (typeof event.usage?.prompt_tokens === 'number') promptTokens = event.usage.prompt_tokens;
        if (typeof event.usage?.completion_tokens === 'number') completionTokens = event.usage.completion_tokens;
        for (const call of choice?.delta?.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : tools.size;
          const existing = tools.get(index) ?? { callId: typeof call.id === 'string' ? call.id : `${this.provider}-call-${index + 1}`, name: '', arguments: '' };
          if (typeof call.id === 'string') existing.callId = call.id;
          if (typeof call.function?.name === 'string') existing.name = call.function.name;
          if (typeof call.function?.arguments === 'string') existing.arguments += call.function.arguments;
          tools.set(index, existing);
        }
      }
    };
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      consume(decoder.decode(next.value, { stream: true }));
    }
    consume(decoder.decode());
    if (!completed) throw new OpenAIProviderError('incomplete', `${this.provider} streaming response ended before completion.`, { retryable: true });
    return {
      content,
      model,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(tools.size === 0 ? {} : { toolCalls: [...tools.values()].filter((tool) => tool.name !== '') }),
      ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined
        ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) }
        : {}),
      ...(response.headers.get('x-request-id') === null ? {} : { requestId: response.headers.get('x-request-id')! }),
    };
  }

  private async resolveApiKey(agent: AgentDefinition): Promise<string> {
    if (agent.model.secretRef !== undefined) {
      if (this.secretBroker === undefined) throw new Error(`A configured Vault secret broker is required for the ${this.provider} connection.`);
      return this.secretBroker.get(agent.model.secretRef);
    }
    return this.apiKey?.trim() ?? '';
  }

  private async delay(durationMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, durationMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
}
