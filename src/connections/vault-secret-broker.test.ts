import { afterEach, describe, expect, it, vi } from 'vitest';

import { VaultSecretBroker } from './vault-secret-broker.js';

afterEach(() => vi.unstubAllGlobals());

describe('VaultSecretBroker', () => {
  it('writes and reads only the Vault-backed secret reference', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { data: { value: 'secret-value' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const broker = new VaultSecretBroker({ address: 'http://vault.test', token: 'dev-token' });
    await broker.put('connections/openai', 'secret-value');
    await expect(broker.get('connections/openai')).resolves.toBe('secret-value');
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://vault.test/v1/secret/data/connections/openai', expect.objectContaining({ method: 'POST', body: JSON.stringify({ data: { value: 'secret-value' } }) }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://vault.test/v1/secret/data/connections/openai', expect.objectContaining({ headers: { 'X-Vault-Token': 'dev-token' } }));
  });

  it('rejects path traversal in secret references', async () => {
    const broker = new VaultSecretBroker({ address: 'http://vault.test', token: 'dev-token' });
    await expect(broker.get('../openai')).rejects.toThrow(/invalid/);
  });
});

