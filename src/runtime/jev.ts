import type { SecretBroker } from '../connections/secret-broker.js';
import { OpenAICompatibleClient, type OpenAICompatibleClientOptions } from './openai-compatible.js';

/**
 * Jev's local control adapter uses the OpenAI-compatible transport, while
 * keeping a distinct provider identity and Vault-backed connection. This
 * lets workflows declare Jev explicitly without embedding credentials or
 * teaching the executor a second chat protocol.
 */
export class JevClient extends OpenAICompatibleClient {
  public constructor(options: Omit<OpenAICompatibleClientOptions, 'provider'> & { provider?: string; secretBroker?: SecretBroker } = {}) {
    super({
      ...options,
      provider: options.provider?.trim() || 'jev',
      baseUrl: options.baseUrl ?? process.env.JEV_BASE_URL ?? process.env.TYPESAFE_AI_BASE_URL,
    });
  }
}
