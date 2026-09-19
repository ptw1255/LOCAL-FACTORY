import type { AgentDefinition } from '../domain/types.js';
import type { SecretBroker } from '../connections/secret-broker.js';
import { OpenAIProviderError, type OpenAIClient, type OpenAIModelResult } from './openai.js';

export interface GeminiClientOptions {
  baseUrl?: string;
  apiKey?: string;
  secretBroker?: SecretBroker;
  fetcher?: typeof fetch;
}

interface GeminiPart { text?: unknown; functionCall?: { name?: unknown; args?: unknown }; }
interface GeminiResponse {
  responseId?: unknown;
  modelVersion?: unknown;
  candidates?: Array<{ finishReason?: unknown; content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
}

/** Google Gemini generate-content adapter behind the provider-neutral contract. */
export class GeminiClient implements OpenAIClient {
  public readonly provider = 'gemini' as const;
  public readonly capabilities = ['text', 'streaming', 'tools', 'usage', 'request_ids'] as const;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly secretBroker?: SecretBroker;
  private readonly fetcher: typeof fetch;

  public constructor(options: GeminiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.secretBroker = options.secretBroker;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async chat(input: { agent: AgentDefinition; goal: string; signal: AbortSignal; traceId?: string; tenantId?: string; projectId?: string }): Promise<OpenAIModelResult> {
    const startedAt = Date.now();
    const model = input.agent.model.model;
    if (model === undefined) throw new Error(`Gemini agent "${input.agent.id}" must declare model.model.`);
    const apiKey = await this.resolveApiKey(input.agent, input);
    if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'Gemini request was cancelled.', { retryable: false });
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: input.agent.instructions }] },
      contents: [{ role: 'user', parts: [{ text: input.goal }] }],
      ...(input.agent.limits.maxTokens === undefined ? {} : { generationConfig: { maxOutputTokens: input.agent.limits.maxTokens } }),
      ...(input.agent.tools.length === 0 ? {} : { tools: [{ function_declarations: input.agent.tools.filter((name, index, values) => values.indexOf(name) === index).map((name) => ({ name, description: `Declared workflow tool: ${name}`, parameters: { type: 'OBJECT', properties: {}, additionalProperties: true } })) }] }),
    };
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.agent.limits.maxDurationMs)]);
    const stream = input.agent.model.streaming === true;
    let response: Response | undefined;
    let lastTransient: OpenAIProviderError | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await this.fetcher(this.endpoint(input.agent, model, apiKey, stream), {
          method: 'POST',
          headers: {
            accept: stream ? 'text/event-stream' : 'application/json',
            'content-type': 'application/json',
            ...(input.traceId === undefined ? {} : { 'x-client-request-id': input.traceId }),
          },
          signal,
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (input.signal.aborted) throw new OpenAIProviderError('cancelled', 'Gemini request was cancelled.', { retryable: false });
        lastTransient = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? new OpenAIProviderError('timeout', 'Gemini request timed out.')
          : new OpenAIProviderError('connection', 'Gemini request could not connect to the provider.');
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
        lastTransient = new OpenAIProviderError(code, `Gemini request failed with status ${response.status}${detail === '' ? '.' : `: ${detail}`}`, { status: response.status });
      }
      const transient = lastTransient ?? new OpenAIProviderError('connection', 'Gemini request could not connect to the provider.');
      if (!transient.retryable || attempt >= 3) throw transient;
      await this.delay(250 * attempt, signal);
      response = undefined;
    }
    if (response === undefined) throw lastTransient ?? new OpenAIProviderError('connection', 'Gemini request could not connect to the provider.');
    if (stream) return { ...await this.parseStream(response, model, input.agent.model.pricing), latencyMs: Date.now() - startedAt };
    let parsed: GeminiResponse;
    try { parsed = await response.json() as GeminiResponse; } catch { throw new OpenAIProviderError('incomplete', 'Gemini response was not valid JSON.', { retryable: true }); }
    return { ...this.normalize(parsed, model, input.agent.model.pricing, response.headers.get('x-request-id') ?? undefined), latencyMs: Date.now() - startedAt };
  }

  private endpoint(agent: AgentDefinition, model: string, apiKey: string, stream: boolean): string {
    const root = (agent.model.endpoint ?? this.baseUrl).replace(/\/$/, '');
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const base = root.includes(':generateContent') || root.includes(':streamGenerateContent')
      ? root
      : `${root}/v1beta/models/${encodeURIComponent(model)}:${action}`;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}key=${encodeURIComponent(apiKey)}${stream ? '&alt=sse' : ''}`;
  }

  private normalize(value: GeminiResponse, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }, requestId?: string): OpenAIModelResult {
    const candidate = value.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.flatMap((part) => typeof part.text === 'string' ? [part.text] : []).join('');
    const toolCalls = parts.flatMap((part, index) => part.functionCall !== undefined && typeof part.functionCall.name === 'string'
      ? [{ callId: `gemini-call-${index + 1}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) }]
      : []);
    const promptTokens = typeof value.usageMetadata?.promptTokenCount === 'number' ? value.usageMetadata.promptTokenCount : undefined;
    const completionTokens = typeof value.usageMetadata?.candidatesTokenCount === 'number' ? value.usageMetadata.candidatesTokenCount : undefined;
    return {
      content,
      model: typeof value.modelVersion === 'string' ? value.modelVersion : fallbackModel,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(typeof candidate?.finishReason === 'string' ? { finishReason: candidate.finishReason } : {}),
      ...(typeof value.responseId === 'string' ? { requestId: value.responseId } : requestId === undefined ? {} : { requestId }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}),
    };
  }

  private async parseStream(response: Response, fallbackModel: string, pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }): Promise<OpenAIModelResult> {
    if (response.body === null) throw new OpenAIProviderError('incomplete', 'Gemini streaming response did not include a body.', { retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = fallbackModel;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let requestId: string | undefined;
    const tools: OpenAIModelResult['toolCalls'] = [];
    const consume = (chunk: string): void => {
      buffer += chunk;
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (data === undefined) continue;
        let parsed: GeminiResponse;
        try { parsed = JSON.parse(data) as GeminiResponse; } catch { continue; }
        if (typeof parsed.responseId === 'string') requestId = parsed.responseId;
        const candidate = parsed.candidates?.[0];
        if (typeof parsed.modelVersion === 'string') model = parsed.modelVersion;
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === 'string') content += part.text;
          if (part.functionCall !== undefined && typeof part.functionCall.name === 'string') tools.push({ callId: `gemini-call-${tools.length + 1}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
        }
        if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
        if (typeof parsed.usageMetadata?.promptTokenCount === 'number') promptTokens = parsed.usageMetadata.promptTokenCount;
        if (typeof parsed.usageMetadata?.candidatesTokenCount === 'number') completionTokens = parsed.usageMetadata.candidatesTokenCount;
      }
    };
    while (true) { const next = await reader.read(); if (next.done) break; consume(decoder.decode(next.value, { stream: true })); }
    consume(decoder.decode());
    if (finishReason === undefined && content === '' && tools.length === 0) throw new OpenAIProviderError('incomplete', 'Gemini streaming response ended before completion.', { retryable: true });
    return { content, model, ...(promptTokens === undefined ? {} : { promptTokens }), ...(completionTokens === undefined ? {} : { completionTokens }), ...(finishReason === undefined ? {} : { finishReason }), ...(requestId === undefined ? {} : { requestId }), ...(tools.length === 0 ? {} : { toolCalls: tools }), ...(promptTokens !== undefined && completionTokens !== undefined && pricing !== undefined ? { estimatedCostUsd: Number(((promptTokens / 1_000) * pricing.promptPer1kUsd + (completionTokens / 1_000) * pricing.completionPer1kUsd).toFixed(6)) } : {}) };
  }

  private async resolveApiKey(agent: AgentDefinition, scope: { tenantId?: string; projectId?: string }): Promise<string> {
    if (agent.model.secretRef !== undefined) {
      if (this.secretBroker === undefined) throw new Error('A configured Vault secret broker is required for the Gemini connection.');
      return scope.tenantId === undefined && scope.projectId === undefined
        ? this.secretBroker.get(agent.model.secretRef)
        : this.secretBroker.get(agent.model.secretRef, scope);
    }
    if (this.apiKey === undefined || this.apiKey.trim() === '') throw new OpenAIProviderError('authentication', 'Gemini credentials are not configured.', { retryable: false });
    return this.apiKey;
  }

  private async delay(durationMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, durationMs); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  }
}
