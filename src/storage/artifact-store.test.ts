import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileArtifactStore } from './artifact-store.js';

describe('FileArtifactStore', () => {
  it('stores content by hash, deduplicates it, and verifies reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-artifacts-'));
    const store = new FileArtifactStore(root);
    const first = await store.put({ kind: 'test-output', content: JSON.stringify({ ok: true }), contentType: 'application/json', runId: 'run-1' });
    const second = await store.put({ kind: 'other-kind', content: JSON.stringify({ ok: true }), contentType: 'application/json', runId: 'run-2' });

    expect(first.id).toMatch(/^artifact:sha256:[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    await expect(store.get(first.id)).resolves.toEqual(expect.objectContaining({ reference: first }));
    await expect(store.get(first.id)).resolves.toMatchObject({ content: new TextEncoder().encode('{"ok":true}') });
  });

  it('rejects invalid artifact identifiers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-artifacts-'));
    const store = new FileArtifactStore(root);
    await expect(store.get('artifact:../../state')).rejects.toThrow('invalid');
  });

  it('prunes metadata and data older than the retention cutoff', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-artifacts-'));
    const store = new FileArtifactStore(root);
    const reference = await store.put({ kind: 'test-output', content: 'old', contentType: 'text/plain' });
    const metadataPath = path.join(root, `${reference.sha256}.meta`);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { reference: typeof reference };
    metadata.reference.createdAt = new Date(Date.now() - 3_600_000).toISOString();
    await writeFile(metadataPath, JSON.stringify(metadata));

    expect(await store.prune(new Date().toISOString())).toBe(1);
    await expect(store.get(reference.id)).rejects.toThrow();
  });
});
