import type { SecretBroker } from './secret-broker.js';

export interface VaultSecretBrokerOptions {
  address: string;
  token: string;
  mount?: string;
}

/** Minimal Vault KV v2 client using the platform's native fetch implementation. */
export class VaultSecretBroker implements SecretBroker {
  private readonly address: string;
  private readonly token: string;
  private readonly mount: string;

  public constructor(options: VaultSecretBrokerOptions) {
    this.address = options.address.replace(/\/$/, '');
    this.token = options.token;
    this.mount = options.mount ?? 'secret';
  }

  public async put(reference: string, value: string): Promise<void> {
    const response = await fetch(`${this.address}/v1/${this.mount}/data/${this.path(reference)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Token': this.token },
      body: JSON.stringify({ data: { value } }),
    });
    if (!response.ok) {
      throw new Error(`Vault secret write failed with status ${response.status}.`);
    }
  }

  public async get(reference: string): Promise<string> {
    const response = await fetch(`${this.address}/v1/${this.mount}/data/${this.path(reference)}`, {
      headers: { 'X-Vault-Token': this.token },
    });
    if (!response.ok) {
      throw new Error(`Vault secret read failed with status ${response.status}.`);
    }
    const payload = (await response.json()) as { data?: { data?: { value?: unknown } } };
    const value = payload.data?.data?.value;
    if (typeof value !== 'string') throw new Error('Vault secret payload is invalid.');
    return value;
  }

  public async delete(reference: string): Promise<void> {
    const response = await fetch(`${this.address}/v1/${this.mount}/data/${this.path(reference)}`, {
      method: 'DELETE',
      headers: { 'X-Vault-Token': this.token },
    });
    if (!response.ok) throw new Error(`Vault secret delete failed with status ${response.status}.`);
  }

  private path(reference: string): string {
    const path = reference.replace(/^\/+|\/+$/g, '');
    if (path.length === 0 || path.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error('Vault secret reference is invalid.');
    }
    return path;
  }
}
