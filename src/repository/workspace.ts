import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, rm, stat, unlink, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 20_000;
const ALLOWED_CHECKS = new Set(['npm test', 'npm run typecheck', 'npm run build']);

export interface RepositoryEntry { path: string; kind: 'file' | 'directory'; size?: number }
export interface CheckResult { command: string; exitCode: number; durationMs: number; output: string; timedOut: boolean }
export interface PatchArtifact { id: string; baseRevision: string; changedPaths: string[]; files?: Array<{ path: string; sha256?: string }>; patch: string; createdAt: string }
export type RepositoryMutation =
  | { operation: 'create' | 'replace'; path: string; content: string; expectedSha256?: string }
  | { operation: 'delete'; path: string; expectedSha256?: string }
  | { operation: 'rename'; path: string; newPath: string; expectedSha256?: string };
export interface MutationResult { operation: RepositoryMutation['operation']; path: string; newPath?: string; sha256?: string }
export interface MutationTransaction { id: string; baseRevision: string; results: MutationResult[]; patch: PatchArtifact; rolledBack: false }
export class RepositoryMutationError extends Error {
  public readonly code = 'REPOSITORY_MUTATION_FAILED';
  public constructor(message: string, public readonly transactionId: string, public readonly rolledBack: boolean) { super(message); this.name = 'RepositoryMutationError'; }
}
export interface GitRevisionResult { branch: string; revision: string }

function truncate(value: string): string { return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n… output truncated` : value; }

export class RepositoryWorkspace {
  private constructor(private readonly root: string, private readonly writable = false, private readonly temporary = false) {}

  public static async open(root: string): Promise<RepositoryWorkspace> {
    const resolved = await realpath(root);
    if (!(await stat(resolved)).isDirectory()) throw new Error('Repository workspace must be a directory.');
    return new RepositoryWorkspace(resolved);
  }

  public get path(): string { return this.root; }

  /** Copy the repository into a temporary run-specific workspace before mutation or checks. */
  public async cloneForRun(runId: string): Promise<RepositoryWorkspace> {
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const target = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), `factory-run-${safeRunId}-`)));
    await cp(this.root, target, {
      recursive: true,
      filter: (source) => !source.split(path.sep).some((segment) => segment === 'node_modules'),
    });
    return new RepositoryWorkspace(await realpath(target), true, true);
  }

  /** Remove a temporary run workspace. Safe to call multiple times. */
  public async dispose(): Promise<void> {
    if (this.temporary) await rm(this.root, { recursive: true, force: true });
  }

  public async read(relativePath: string): Promise<string> {
    return readFile(this.safePath(relativePath), 'utf8');
  }

  public async list(relativePath = '.'): Promise<RepositoryEntry[]> {
    const directory = this.safePath(relativePath);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory, { withFileTypes: true });
    return Promise.all(entries.filter((entry) => !['.git', 'node_modules'].includes(entry.name)).map(async (entry) => {
      const entryPath = path.join(relativePath, entry.name);
      return entry.isDirectory() ? { path: entryPath, kind: 'directory' as const } : { path: entryPath, kind: 'file' as const, size: (await stat(this.safePath(entryPath))).size };
    }));
  }

  public async diff(): Promise<string> {
    const result = await execFileAsync('git', ['-C', this.root, 'diff', '--no-ext-diff', '--'], { maxBuffer: MAX_OUTPUT * 16 });
    const untracked = await this.untrackedPaths();
    const untrackedDiff = await Promise.all(untracked.map(async (relativePath) => {
      const content = await readFile(this.safePath(relativePath), 'utf8');
      const lines = content.split('\n');
      return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
    }));
    return truncate(`${result.stdout}${result.stderr}${untrackedDiff.length === 0 ? '' : `${result.stdout || result.stderr ? '\n' : ''}${untrackedDiff.join('\n')}`}`);
  }

  public async patchArtifact(): Promise<PatchArtifact> {
    const [revision, patch, paths] = await Promise.all([
      this.revision().catch(() => 'unversioned'),
      this.diff().catch(() => ''),
      this.changedPaths().catch(() => []),
    ]);
    const files = await Promise.all(paths.map(async (relativePath) => {
      try {
        return { path: relativePath, sha256: createHash('sha256').update(await readFile(this.safePath(relativePath))).digest('hex') };
      } catch {
        return { path: relativePath };
      }
    }));
    const createdAt = new Date().toISOString();
    const id = `sha256:${(await import('node:crypto')).createHash('sha256').update(JSON.stringify({ revision, patch, paths, files })).digest('hex')}`;
    return { id, baseRevision: revision, changedPaths: paths, files, patch, createdAt };
  }

  public async revision(): Promise<string> {
    const result = await execFileAsync('git', ['-C', this.root, 'rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  public async changedPaths(): Promise<string[]> {
    const result = await execFileAsync('git', ['-C', this.root, 'diff', '--name-only', '--']);
    return [...new Set([...result.stdout.split('\n').map((value) => value.trim()).filter(Boolean), ...await this.untrackedPaths()])];
  }

  private async untrackedPaths(): Promise<string[]> {
    const result = await execFileAsync('git', ['-C', this.root, 'ls-files', '--others', '--exclude-standard']);
    return result.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  }

  public async runCheck(command: string, timeoutMs = 120_000): Promise<CheckResult> {
    if (!ALLOWED_CHECKS.has(command)) throw new Error(`Unsupported repository check "${command}".`);
    const started = Date.now();
    try {
      const result = await execFileAsync(command.split(' ')[0]!, command.split(' ').slice(1), { cwd: this.root, timeout: timeoutMs, maxBuffer: MAX_OUTPUT * 2 });
      return { command, exitCode: 0, durationMs: Date.now() - started, output: truncate(`${result.stdout}${result.stderr}`), timedOut: false };
    } catch (error) {
      const failure = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
      return { command, exitCode: typeof failure.code === 'number' ? failure.code : 1, durationMs: Date.now() - started, output: truncate(`${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? ''}`), timedOut: failure.killed === true };
    }
  }

  public async applyMutations(
    operations: unknown[],
    options: { protectedPaths?: string[]; maxOperations?: number; maxBytes?: number } = {},
  ): Promise<MutationResult[]> {
    return (await this.applyMutationsTransaction(operations, options)).results;
  }

  /** Apply changes atomically and return a content-addressed patch transaction. */
  public async applyMutationsTransaction(
    operations: unknown[],
    options: { protectedPaths?: string[]; maxOperations?: number; maxBytes?: number } = {},
  ): Promise<MutationTransaction> {
    if (!this.writable) throw new Error('Repository workspace is read-only; mutations require an isolated run workspace.');
    const baseRevision = await this.revision().catch(() => 'unversioned');
    const maxOperations = options.maxOperations ?? 100;
    if (operations.length > maxOperations) throw new Error(`Repository mutation exceeds the ${maxOperations}-operation limit.`);
    const parsed = operations.map((operation, index) => this.parseMutation(operation, index));
    const transactionId = `sha256:${createHash('sha256').update(JSON.stringify({ baseRevision, parsed })).digest('hex')}`;
    const protectedPaths = (options.protectedPaths ?? []).map((value) => this.normalizeRelative(value));
    const totalBytes = parsed.reduce((sum, operation) => sum + ('content' in operation ? Buffer.byteLength(operation.content) : 0), 0);
    if (totalBytes > (options.maxBytes ?? 1_000_000)) throw new Error('Repository mutation exceeds the byte limit.');

    for (const operation of parsed) {
      await this.assertWritablePath(operation.path, protectedPaths);
      if ('newPath' in operation) await this.assertWritablePath(operation.newPath, protectedPaths);
      await this.assertExpectedHash(operation.path, operation.expectedSha256);
    }

    const originals = new Map<string, Buffer | undefined>();
    const remember = async (relativePath: string): Promise<void> => {
      if (originals.has(relativePath)) return;
      try { originals.set(relativePath, await readFile(this.safePath(relativePath))); }
      catch { originals.set(relativePath, undefined); }
    };
    let rollbackComplete = true;
    try {
      const results: MutationResult[] = [];
      for (const operation of parsed) {
        await remember(operation.path);
        if (operation.operation === 'rename') await remember(operation.newPath);
        const target = this.safePath(operation.path);
        if (operation.operation === 'delete') {
          await unlink(target);
          results.push({ operation: operation.operation, path: operation.path });
        } else if (operation.operation === 'rename') {
          await mkdir(path.dirname(this.safePath(operation.newPath)), { recursive: true });
          await rename(target, this.safePath(operation.newPath));
          results.push({ operation: operation.operation, path: operation.path, newPath: operation.newPath });
        } else {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, operation.content, 'utf8');
          results.push({ operation: operation.operation, path: operation.path, sha256: createHash('sha256').update(operation.content).digest('hex') });
        }
      }
      return { id: transactionId, baseRevision, results, patch: await this.patchArtifact(), rolledBack: false };
    } catch (error) {
      for (const [relativePath, content] of originals) {
        const target = this.safePath(relativePath);
        try {
          if (content === undefined) {
            try {
              await unlink(target);
            } catch (rollbackError) {
              // An originally absent path is already in the desired state.
              if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') throw rollbackError;
            }
          } else {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content);
          }
        } catch { rollbackComplete = false; }
      }
      throw new RepositoryMutationError(error instanceof Error ? error.message : 'Repository mutation failed.', transactionId, rollbackComplete);
    }
  }

  public async createBranch(branch: string, baseRevision: string): Promise<GitRevisionResult> {
    this.assertWritableRepository();
    this.assertBranchName(branch);
    const current = await this.revision();
    if (current !== baseRevision) throw new Error(`Repository base revision changed from ${baseRevision} to ${current}.`);
    await this.git(['switch', '-c', branch]);
    return { branch, revision: await this.revision() };
  }

  public async commit(message: string, paths: string[] = []): Promise<GitRevisionResult> {
    this.assertWritableRepository();
    if (message.trim() === '') throw new Error('A commit message is required.');
    const selected = paths.length === 0 ? await this.changedPaths() : paths.map((value) => this.normalizeRelative(value));
    if (selected.length === 0) throw new Error('No changed paths are available to commit.');
    for (const relativePath of selected) await this.assertNoSymlinkEscape(relativePath);
    await this.git(['add', '--', ...selected]);
    const staged = await execFileAsync('git', ['-C', this.root, 'diff', '--cached', '--quiet']).then(() => false).catch(() => true);
    if (!staged) throw new Error('No changes are staged for commit.');
    await this.git(['commit', '--no-verify', '-m', message.trim()]);
    const branch = (await execFileAsync('git', ['-C', this.root, 'branch', '--show-current'])).stdout.trim();
    return { branch, revision: await this.revision() };
  }

  public async push(branch: string, remote = 'origin'): Promise<GitRevisionResult> {
    this.assertWritableRepository();
    this.assertBranchName(branch);
    if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith('-')) throw new Error('Git remote is not allowed.');
    await this.git(['push', '--set-upstream', remote, branch]);
    return { branch, revision: await this.revision() };
  }

  public async currentBranch(): Promise<string> {
    const result = await execFileAsync('git', ['-C', this.root, 'branch', '--show-current']);
    const branch = result.stdout.trim();
    if (branch === '') throw new Error('Repository is in a detached HEAD state.');
    return branch;
  }

  private parseMutation(value: unknown, index: number): RepositoryMutation {
    if (value === null || typeof value !== 'object') throw new Error(`Repository mutation ${index + 1} must be an object.`);
    const candidate = value as Record<string, unknown>;
    const operation = candidate.operation;
    if (operation !== 'create' && operation !== 'replace' && operation !== 'delete' && operation !== 'rename') throw new Error(`Repository mutation ${index + 1} has an unsupported operation.`);
    if (typeof candidate.path !== 'string' || candidate.path.trim() === '') throw new Error(`Repository mutation ${index + 1} requires a path.`);
    const pathValue = this.normalizeRelative(candidate.path);
    const expectedSha256 = candidate.expectedSha256 === undefined ? undefined : String(candidate.expectedSha256);
    if (operation === 'rename') {
      if (typeof candidate.newPath !== 'string' || candidate.newPath.trim() === '') throw new Error(`Repository mutation ${index + 1} requires newPath.`);
      return { operation, path: pathValue, newPath: this.normalizeRelative(candidate.newPath), ...(expectedSha256 === undefined ? {} : { expectedSha256 }) };
    }
    if (operation !== 'delete' && typeof candidate.content !== 'string') throw new Error(`Repository mutation ${index + 1} requires text content.`);
    return operation === 'delete'
      ? { operation, path: pathValue, ...(expectedSha256 === undefined ? {} : { expectedSha256 }) }
      : { operation, path: pathValue, content: candidate.content as string, ...(expectedSha256 === undefined ? {} : { expectedSha256 }) };
  }

  private normalizeRelative(relativePath: string): string {
    if (relativePath.trim() === '' || path.isAbsolute(relativePath)) throw new Error('Repository paths must be non-empty and relative.');
    const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Repository path escapes the workspace boundary.');
    return normalized;
  }

  private async assertWritablePath(relativePath: string, protectedPaths: string[]): Promise<void> {
    if (protectedPaths.some((protectedPath) => relativePath === protectedPath || relativePath.startsWith(`${protectedPath}/`))) throw new Error(`Repository path "${relativePath}" is protected.`);
    await this.assertNoSymlinkEscape(relativePath);
  }

  private async assertNoSymlinkEscape(relativePath: string): Promise<void> {
    let current = this.safePath(relativePath);
    while (current !== this.root) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error(`Repository path "${relativePath}" traverses a symbolic link.`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('symbolic link')) throw error;
      }
      current = path.dirname(current);
    }
  }

  private async assertExpectedHash(relativePath: string, expected?: string): Promise<void> {
    if (expected === undefined) return;
    let actual: string | undefined;
    try { actual = createHash('sha256').update(await readFile(this.safePath(relativePath))).digest('hex'); } catch { actual = undefined; }
    if (actual !== expected) throw new Error(`Repository file "${relativePath}" does not match the expected content hash.`);
  }

  private assertWritableRepository(): void {
    if (!this.writable) throw new Error('Repository workspace is read-only; Git side effects require an isolated run workspace.');
  }

  private assertBranchName(branch: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.')) throw new Error('Git branch name is not allowed.');
  }

  private async git(args: string[]): Promise<void> {
    await execFileAsync('git', ['-C', this.root, ...args], { maxBuffer: MAX_OUTPUT * 2 });
  }

  private safePath(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) throw new Error('Repository path escapes the workspace boundary.');
    return resolved;
  }
}
