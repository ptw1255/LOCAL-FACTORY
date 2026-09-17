import { execFile } from 'node:child_process';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryConflictError, RepositoryPolicyError, RepositoryWorkspace } from './workspace.js';

const execFileAsync = (file: string, args: string[], options: { cwd?: string } = {}) => new Promise<void>((resolve, reject) => {
  execFile(file, args, options, (error) => error === null ? resolve() : reject(error));
});

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

  it('supports the standard lint and integration-test check profiles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-check-profiles-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
      lint: 'node -e "process.stdout.write(\'lint-ok\')"',
      'test:integration': 'node -e "process.stdout.write(\'integration-ok\')"',
    } }));
    await expect((await RepositoryWorkspace.open(root)).runCheck('npm run lint')).resolves.toMatchObject({ command: 'npm run lint', exitCode: 0, timedOut: false });
    await expect((await RepositoryWorkspace.open(root)).runCheck('npm run test:integration')).resolves.toMatchObject({ command: 'npm run test:integration', exitCode: 0, timedOut: false });
  });

  it('normalizes a timed-out allow-listed check', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-check-timeout-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "setTimeout(() => {}, 1000)"' } }));
    const result = await (await RepositoryWorkspace.open(root)).runCheck('npm run typecheck', 20);
    expect(result).toMatchObject({ command: 'npm run typecheck', timedOut: true, exitCode: expect.any(Number) });
  });

  it('does not expose factory credentials to repository check processes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-check-environment-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.stdout.write((process.env.FACTORY_CHECK_SECRET ?? \'missing\') + \':\' + (process.env.npm_config_offline ?? \'unset\'))"' } }));
    vi.stubEnv('FACTORY_CHECK_SECRET', 'must-not-leak');
    try {
      const result = await (await RepositoryWorkspace.open(root)).runCheck('npm run typecheck');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('missing:true');
      expect(result.output).not.toContain('must-not-leak');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('cancels an in-flight allow-listed check through its abort signal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-check-cancel-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "setTimeout(() => {}, 1000)"' } }));
    const controller = new AbortController();
    const check = (await RepositoryWorkspace.open(root)).runCheck('npm run typecheck', 5_000, controller.signal);
    setTimeout(() => controller.abort(new Error('operator cancelled')), 20);
    await expect(check).resolves.toMatchObject({ command: 'npm run typecheck', cancelled: true, timedOut: false });
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

  it('returns a content-addressed mutation transaction with patch provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-repo-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), 'before');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    const run = await (await RepositoryWorkspace.open(root)).cloneForRun('run-transaction');
    const transaction = await run.applyMutationsTransaction([{ operation: 'replace', path: 'README.md', content: 'after' }]);
    expect(transaction.id).toMatch(/^sha256:/);
    expect(transaction.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(transaction.results).toHaveLength(1);
    expect(transaction.patch.id).toMatch(/^sha256:/);
    expect(transaction.patch.changedPaths).toContain('README.md');
    expect(transaction.patch.files).toEqual([{ path: 'README.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(transaction.rolledBack).toBe(false);
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

  it('excludes local secret files from run clones while retaining safe templates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-repo-secret-files-'));
    await writeFile(path.join(root, '.env'), 'API_KEY=secret');
    await writeFile(path.join(root, '.env.local'), 'API_KEY=secret');
    await writeFile(path.join(root, '.env.example'), 'API_KEY=replace-me');
    await writeFile(path.join(root, 'server.pem'), 'private key');
    await writeFile(path.join(root, 'README.md'), 'safe');
    const run = await (await RepositoryWorkspace.open(root)).cloneForRun('secret-filter');
    await expect(run.read('.env')).rejects.toThrow();
    await expect(run.read('.env.local')).rejects.toThrow();
    await expect(run.read('server.pem')).rejects.toThrow();
    await expect(run.read('.env.example')).resolves.toBe('API_KEY=replace-me');
    await expect(run.read('README.md')).resolves.toBe('safe');
    await run.dispose();
  });

  it('creates a branch and commits only declared changed paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-git-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), 'before');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    const source = await RepositoryWorkspace.open(root);
    const run = await source.cloneForRun('run-git');
    const base = await run.revision();
    await run.createBranch('factory/change', base);
    await run.applyMutations([{ operation: 'replace', path: 'README.md', content: 'after' }]);
    const committed = await run.commit('Apply workflow change', ['README.md']);
    expect(committed.branch).toBe('factory/change');
    expect(committed.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(await run.currentBranch()).toBe('factory/change');
    await expect(run.createBranch('factory/change', committed.revision)).rejects.toThrow();
    await expect(run.push('main')).rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(run.push('factory/change', 'upstream')).rejects.toBeInstanceOf(RepositoryPolicyError);
  });

  it('types a stale branch base conflict with expected and actual revisions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-git-conflict-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), 'before');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
    const run = await (await RepositoryWorkspace.open(root)).cloneForRun('run-conflict');
    const error = await run.createBranch('factory/change', '0'.repeat(40)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RepositoryConflictError);
    expect(error).toMatchObject({ code: 'REPOSITORY_CONFLICT', expected: '0'.repeat(40), actual: expect.stringMatching(/^[a-f0-9]{40}$/) });
  });
});
