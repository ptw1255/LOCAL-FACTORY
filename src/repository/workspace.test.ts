import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositoryWorkspace } from './workspace.js';

describe('RepositoryWorkspace', () => {
  it('reads and lists only workspace-contained files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-repo-'));
    await writeFile(path.join(root, 'README.md'), 'hello');
    const workspace = await RepositoryWorkspace.open(root);
    expect(await workspace.read('README.md')).toBe('hello');
    expect((await workspace.list()).map((entry) => entry.path)).toContain('README.md');
    await expect(workspace.read('../outside')).rejects.toThrow(/escapes/);
  });

  it('rejects arbitrary commands and returns bounded check evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-repo-'));
    const workspace = await RepositoryWorkspace.open(root);
    await expect(workspace.runCheck('git status')).rejects.toThrow(/Unsupported/);
    const result = await workspace.runCheck('npm run typecheck', 1_000);
    expect(result.command).toBe('npm run typecheck');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.output.length).toBeLessThanOrEqual(20_020);
  });

  it('creates a content-addressed patch artifact with revision provenance', async () => {
    const workspace = await RepositoryWorkspace.open(process.cwd());
    const artifact = await workspace.patchArtifact();
    expect(artifact.id).toMatch(/^sha256:/);
    expect(artifact.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof artifact.patch).toBe('string');
    expect(Array.isArray(artifact.changedPaths)).toBe(true);
  });

  it('mutates only an isolated run workspace and enforces hashes and protected paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-repo-'));
    await writeFile(path.join(root, 'README.md'), 'before');
    const source = await RepositoryWorkspace.open(root);
    const run = await source.cloneForRun('run-test');

    const result = await run.applyMutations([
      { operation: 'replace', path: 'README.md', content: 'after', expectedSha256: '0'.repeat(64) },
    ]).catch(() => undefined);
    // Use the actual hash to prove optimistic concurrency without hard-coding fixture details.
    const beforeHash = (await import('node:crypto')).createHash('sha256').update('before').digest('hex');
    const replaced = await run.applyMutations([{ operation: 'replace', path: 'README.md', content: 'after', expectedSha256: beforeHash }]);
    expect(result).toBeUndefined();
    expect(replaced[0]?.sha256).toBe((await import('node:crypto')).createHash('sha256').update('after').digest('hex'));
    expect(await run.read('README.md')).toBe('after');
    expect(await source.read('README.md')).toBe('before');
    await expect(run.applyMutations([{ operation: 'replace', path: 'README.md', content: 'blocked' }], { protectedPaths: ['README.md'] })).rejects.toThrow(/protected/);
  });

  it('rejects traversal and symbolic-link escapes before writing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-repo-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'factory-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'linked'));
    const workspace = await RepositoryWorkspace.open(root);
    const run = await workspace.cloneForRun('run-boundary');
    await expect(run.applyMutations([{ operation: 'create', path: '../escape.txt', content: 'nope' }])).rejects.toThrow(/escapes/);
    await expect(run.applyMutations([{ operation: 'create', path: 'linked/new.txt', content: 'nope' }])).rejects.toThrow(/symbolic link/);
  });
});
