import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from 'openai';

import type { AgentDefinition } from '../domain/types.js';
import type { SecretBroker } from '../connections/secret-broker.js';
import {
  OPENAI_CAPABILITIES,
  OpenAIProviderError,
  type OpenAIClient,
  type OpenAIModelResult,
} from './openai.js';
import { openAIToolDefinitions } from './openai.js';

interface SDKResponsesClient {
  responses: {
    create(body: Record<string, unknown>, options?: Record<string, unknown>): {
      withResponse(): Promise<{ data: unknown; request_id?: string | null }>;
    };
  };
}

export interface OpenAISDKClientOptions {
  baseUrl?: string;
  apiKey?: string;
  secretBroker?: SecretBroker;
  fetcher?: typeof fetch;
  clientFactory?: (options: { apiKey: string; baseURL: string; maxRetries: number; timeout: number; fetch?: typeof fetch }) => SDKResponsesClient;
}

/** Official OpenAI Node SDK adapter for the provider-neutral runtime contract. */
export class OpenAISDKClient implements OpenAIClient {
  public readonly provider = 'openai' as const;
  public readonly capabilities = OPENAI_CAPABILITIES;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly secretBroker?: SecretBroker;
  private readonly fetcher?: typeof fetch;
  private readonly clientFactory: NonNullable<OpenAISDKClientOptions['clientFactory']>;

  public constructor(options: OpenAISDKClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.secretBroker = options.secretBroker;
    this.fetcher = options.fetcher;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new OpenAI(clientOptions));
  }

  public async chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string; tenantId?: string; projectId?: string }): Promise<OpenAIModelResult> {
    const startedAt = Date.now();
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`OpenAI agent "${input.agent.id}" must declare model.model.`);
    const apiKey = await this.resolveApiKey(input.agent, input);
    if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'OpenAI request was cancelled.', { retryable: false });
    const client = this.clientFactory({ apiKey, baseURL: input.agent.model.endpoint ?? this.baseUrl, maxRetries: 0, timeout: input.agent.limits.maxDurationMs, ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }) });
    const request = {
      model,
      store: false,
      input: [
        { role: 'developer', content: input.agent.instructions },
        { role: 'user', content: input.goal },
      ],
      ...(input.agent.limits.maxTokens === undefined ? {} : { max_output_tokens: input.agent.limits.maxTokens }),
      ...(this.structuredOutput(input.agent) === undefined ? {} : { text: this.structuredOutput(input.agent) }),
      ...(input.agent.model.streaming === true ? { stream: true } : { stream: false }),
      ...(input.agent.tools.length === 0 ? {} : { tools: openAIToolDefinitions(input.agent) }),
    } satisfies Record<string, unknown>;
    try {
      const promise = client.responses.create(request, {
        signal: input.signal,
        ...(input.traceId === undefined ? {} : { headers: { 'x-client-request-id': input.traceId } }),
      });
      const { data, request_id: requestId } = await promise.withResponse();
      if (input.agent.model.streaming === true) {
        return { ...await this.normalizeStream(data, model, input.signal, input.agent.model.pricing), latencyMs: Date.now() - startedAt, ...(requestId == null ? {} : { requestId }) };
      }
      return { ...this.normalizeResponse(data, model, input.agent.model.pricing, requestId ?? undefined), latencyMs: Date.now() - startedAt };
    } catch (error) {
      throw this.normalizeError(error, apiKey, input.signal);
    }
  }

  private structuredOutput(agent: AgentDefinition): Record<string, unknown> | undefined {
    if (Object.keys(agent.outputSchema).length === 0) return undefined;
    return {
      format: {
        type: 'json_schema',
        name: `${agent.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_output`,
        strict: true,
        schema: agent.outputSchema,
      },
    };
  }

  private normalizeResponse(value: unknown, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }, requestId?: string): OpenAIModelResult {
    const body = value as { model?: unknown; output_text?: unknown; output?: Array<{ type?: unknown; text?: unknown; content?: Array<{ type?: unknown; text?: unknown }>; call_id?: unknown; name?: unknown; arguments?: unknown }>; usage?: { input_tokens?: unknown; output_tokens?: unknown }; status?: unknown };
    const content = typeof body.output_text === 'string'
      ? body.output_text
      : (body.output ?? []).flatMap((item) => item.type === 'message' ? (item.content ?? []).flatMap((part) => part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []) : item.type === 'output_text' && typeof item.text === 'string' ? [item.text] : []).join('');
    const toolCalls = (body.output ?? []).flatMap((item) => item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string'
      ? [{ callId: item.call_id, name: item.name, arguments: item.arguments }]
      : []);
    if ((body.output ?? []).some((item) => item.type === 'refusal')) throw new OpenAIProviderError('refusal', 'OpenAI declined the requested response.', { retryable: false });
    if (body.status === 'incomplete') throw new OpenAIProviderError('incomplete', 'OpenAI response ended before completion.', { retryable: true });
    const promptTokens = typeof body.usage?.input_tokens === 'number' ? body.usage.input_tokens : undefined;
    const completionTokens = typeof body.usage?.output_tokens === 'number' ? body.usage.output_tokens : undefined;
    return {
      content,
      model: typeof body.model === 'string' ? body.model : fallbackModel,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(typeof body.status === 'string' ? { finishReason: body.status } : {}),
      ...(requestId === undefined ? {} : { requestId }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}),
    };
  }

  private async normalizeStream(value: unknown, fallbackModel: string, signal: AbortSignal, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }): Promise<OpenAIModelResult> {
    if (value === null || typeof value !== 'object' || !(Symbol.asyncIterator in value)) throw new OpenAIProviderError('incomplete', 'OpenAI streaming response did not include an async stream.', { retryable: true });
    let content = '';
    let model = fallbackModel;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let completed = false;
    let refused = false;
    const tools = new Map<string, { callId: string; name: string; arguments: string }>();
    for await (const event of value as AsyncIterable<Record<string, unknown>>) {
      signal.throwIfAborted();
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') content += event.delta;
      if (event.type === 'response.refusal.delta') refused = true;
      if (event.type === 'response.completed') completed = true;
      const response = event.response as { model?: unknown; status?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | undefined;
      if (typeof response?.model === 'string') model = response.model;
      if (typeof response?.status === 'string') finishReason = response.status;
      if (typeof response?.usage?.input_tokens === 'number') promptTokens = response.usage.input_tokens;
      if (typeof response?.usage?.output_tokens === 'number') completionTokens = response.usage.output_tokens;
      const item = event.item as { id?: unknown; type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown } | undefined;
      if (event.type === 'response.output_item.added' && item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
        tools.set(typeof item.id === 'string' ? item.id : item.call_id, { callId: item.call_id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '' });
      }
      if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string' && typeof event.item_id === 'string') {
        const tool = tools.get(event.item_id);
        if (tool !== undefined) tool.arguments += event.delta;
      }
      if (event.type === 'response.function_call_arguments.done' && typeof event.item_id === 'string' && typeof event.arguments === 'string') {
        const tool = tools.get(event.item_id);
        if (tool !== undefined) tool.arguments = event.arguments;
      }
    }
    if (refused) throw new OpenAIProviderError('refusal', 'OpenAI declined the requested response.', { retryable: false });
    if (!completed) throw new OpenAIProviderError('incomplete', 'OpenAI streaming response ended before completion.', { retryable: true });
    return {
      content,
      model,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(tools.size === 0 ? {} : { toolCalls: [...tools.values()] }),
      ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}),
    };
  }

  private normalizeError(error: unknown, apiKey: string, signal: AbortSignal): OpenAIProviderError | Error {
    if (error instanceof OpenAIProviderError) return error;
    if (signal.aborted || error instanceof APIUserAbortError) return new OpenAIProviderError('cancelled', 'OpenAI request was cancelled.', { retryable: false });
    if (error instanceof AuthenticationError) return new OpenAIProviderError('authentication', this.safeMessage(error.message, apiKey), { status: error.status, retryable: false });
    if (error instanceof RateLimitError) return new OpenAIProviderError('rate_limited', this.safeMessage(error.message, apiKey), { status: error.status });
    if (error instanceof APIConnectionTimeoutError) return new OpenAIProviderError('timeout', 'OpenAI request timed out.');
    if (error instanceof APIConnectionError) return new OpenAIProviderError('connection', 'OpenAI request could not connect to the provider.');
    if (error instanceof APIError) {
      const code = error.status === 408 ? 'timeout' : error.status !== undefined && error.status >= 500 ? 'server' : 'request';
      return new OpenAIProviderError(code, this.safeMessage(error.message, apiKey), { status: error.status });
    }
    return error instanceof Error ? new OpenAIProviderError('request', this.safeMessage(error.message, apiKey), { retryable: false }) : new OpenAIProviderError('request', 'OpenAI request failed.', { retryable: false });
  }

  private safeMessage(message: string, apiKey: string): string {
    return message.replaceAll(apiKey, '[REDACTED]').slice(0, 500);
  }

  private async resolveApiKey(agent: AgentDefinition, scope: { tenantId?: string; projectId?: string }): Promise<string> {
    if (agent.model.secretRef !== undefined) {
      if (this.secretBroker === undefined) throw new Error('A configured Vault secret broker is required for the OpenAI connection.');
      return scope.tenantId === undefined && scope.projectId === undefined
        ? this.secretBroker.get(agent.model.secretRef)
        : this.secretBroker.get(agent.model.secretRef, scope);
    }
    if (this.apiKey === undefined || this.apiKey.trim() === '') throw new Error('OpenAI credentials are not configured.');
    return this.apiKey;
  }
}
