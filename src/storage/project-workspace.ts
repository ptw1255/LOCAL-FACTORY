import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeletedProjectFileRecord, ProjectDirectoryRecord, ProjectFileRecord } from '../domain/types.js';

export interface ProjectWorkspaceScope {
  tenantId: string;
  projectId: string;
}

export interface ProjectWorkspaceListing {
  files: ProjectFileRecord[];
  directories: ProjectDirectoryRecord[];
}

/**
 * Filesystem source-of-truth for authored project files.
 *
 * The control plane stores compiled artifacts and runtime state; this adapter
 * keeps source text on the mounted workspace volume. Every path component is
 * checked with lstat so symlinks cannot escape a tenant/project root.
 */
export class ProjectWorkspace {
  private readonly root: string;

  public constructor(root: string) {
    this.root = path.resolve(root);
  }

  public async list(scope: ProjectWorkspaceScope): Promise<ProjectWorkspaceListing> {
    const projectRoot = await this.ensureProjectRoot(scope);
    const files: ProjectFileRecord[] = [];
    const directories: ProjectDirectoryRecord[] = [];
    await this.walk(scope, projectRoot, '', files, directories);
    files.sort((left, right) => left.path.localeCompare(right.path));
    directories.sort((left, right) => left.path.localeCompare(right.path));
    return { files, directories };
  }

  public async read(scope: ProjectWorkspaceScope, filePath: string): Promise<ProjectFileRecord | undefined> {
    const target = await this.safeTarget(scope, filePath, true);
    try {
      const details = await lstat(target);
      if (!details.isFile()) return undefined;
      return await this.record(scope, filePath, target, details);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  public async save(scope: ProjectWorkspaceScope, filePath: string, content: string, expectedSha256?: string): Promise<{ status: 'saved' | 'conflict'; file?: ProjectFileRecord }> {
    const target = await this.safeTarget(scope, filePath, true);
    await mkdir(path.dirname(target), { recursive: true });
    await this.rejectSymlinks(path.dirname(await this.ensureProjectRoot(scope)), path.relative(await this.ensureProjectRoot(scope), target), true);
    const current = await this.read(scope, filePath);
    if (expectedSha256 !== undefined && current?.sha256 !== expectedSha256) return { status: 'conflict' };
    await writeFile(target, content, 'utf8');
    return { status: 'saved', file: await this.read(scope, filePath) };
  }

  public async rename(scope: ProjectWorkspaceScope, oldPath: string, newPath: string): Promise<{ status: 'renamed' | 'missing' | 'conflict'; path?: string; newPath?: string }> {
    const source = await this.safeTarget(scope, oldPath, false);
    const destination = await this.safeTarget(scope, newPath, true);
    try {
      const sourceDetails = await lstat(source);
      if (!sourceDetails.isFile()) return { status: 'missing' };
      try {
        await lstat(destination);
        return { status: 'conflict' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.rejectSymlinks(path.dirname(await this.ensureProjectRoot(scope)), path.relative(await this.ensureProjectRoot(scope), source), false);
      await this.rejectSymlinks(path.dirname(await this.ensureProjectRoot(scope)), path.relative(await this.ensureProjectRoot(scope), destination), true);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      return { status: 'renamed', path: oldPath, newPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      throw error;
    }
  }

  public async remove(scope: ProjectWorkspaceScope, filePath: string): Promise<DeletedProjectFileRecord | undefined> {
    const file = await this.read(scope, filePath);
    if (file === undefined) return undefined;
    const trashId = `trash-${randomUUID()}`;
    const deletedAt = new Date().toISOString();
    const trashRoot = path.join(await this.ensureProjectRoot(scope), '.trash', trashId);
    await mkdir(trashRoot, { recursive: true });
    const source = await this.safeTarget(scope, filePath, false);
    await rename(source, path.join(trashRoot, 'content'));
    await writeFile(path.join(trashRoot, 'metadata.json'), JSON.stringify({ ...file, content: undefined, trashId, deletedAt }), 'utf8');
    return { ...file, trashId, deletedAt };
  }

  public async restore(scope: ProjectWorkspaceScope, trashId: string): Promise<ProjectFileRecord | undefined> {
    if (!/^trash-[a-f0-9-]+$/.test(trashId)) return undefined;
    const projectRoot = await this.ensureProjectRoot(scope);
    const trashRoot = path.join(projectRoot, '.trash', trashId);
    try {
      const metadata = JSON.parse(await readFile(path.join(trashRoot, 'metadata.json'), 'utf8')) as { path?: unknown };
      if (typeof metadata.path !== 'string') return undefined;
      const target = await this.safeTarget(scope, metadata.path, true);
      try {
        await lstat(target);
        throw new Error('A file already exists at the deleted file path.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(trashRoot, 'content'), target);
      return await this.read(scope, metadata.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  public async createDirectory(scope: ProjectWorkspaceScope, directoryPath: string): Promise<{ status: 'created' | 'exists'; directory: ProjectDirectoryRecord }> {
    const target = await this.safeTarget(scope, directoryPath, true);
    await this.rejectSymlinks(path.dirname(await this.ensureProjectRoot(scope)), path.relative(await this.ensureProjectRoot(scope), target), true);
    try {
      const details = await lstat(target);
      if (!details.isDirectory()) throw new Error('A file already exists at the directory path.');
      return { status: 'exists', directory: { tenantId: scope.tenantId, projectId: scope.projectId, path: directoryPath, createdAt: details.birthtime.toISOString() } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(target, { recursive: true });
    return { status: 'created', directory: { tenantId: scope.tenantId, projectId: scope.projectId, path: directoryPath, createdAt: new Date().toISOString() } };
  }

  private async walk(scope: ProjectWorkspaceScope, directory: string, relative: string, files: ProjectFileRecord[], directories: ProjectDirectoryRecord[]): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (relative !== '') {
      const details = await lstat(directory);
      directories.push({ tenantId: scope.tenantId, projectId: scope.projectId, path: relative, createdAt: details.birthtime.toISOString() });
    }
    for (const entry of entries) {
      if (relative === '' && entry.name === '.trash') continue;
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.walk(scope, child, childRelative, files, directories);
      else if (entry.isFile()) files.push(await this.record(scope, childRelative, child));
    }
  }

  private async record(scope: ProjectWorkspaceScope, filePath: string, target: string, details?: { mtime: Date }): Promise<ProjectFileRecord> {
    const content = await readFile(target, 'utf8');
    const metadata = details ?? await stat(target);
    return { tenantId: scope.tenantId, projectId: scope.projectId, path: filePath, content, sha256: createHash('sha256').update(content).digest('hex'), updatedAt: metadata.mtime.toISOString() };
  }

  private async ensureProjectRoot(scope: ProjectWorkspaceScope): Promise<string> {
    this.validateScopePart(scope.tenantId, 'tenant');
    this.validateScopePart(scope.projectId, 'project');
    await mkdir(this.root, { recursive: true });
    const rootDetails = await lstat(this.root);
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) throw new Error('Project workspace root must be a directory without symlinks.');
    const tenantRoot = path.join(this.root, scope.tenantId);
    await mkdir(tenantRoot, { recursive: true });
    const tenantDetails = await lstat(tenantRoot);
    if (tenantDetails.isSymbolicLink() || !tenantDetails.isDirectory()) throw new Error('Tenant workspace scope must be a directory without symlinks.');
    const projectRoot = path.join(this.root, scope.tenantId, scope.projectId);
    await mkdir(projectRoot, { recursive: true });
    const projectDetails = await lstat(projectRoot);
    if (projectDetails.isSymbolicLink() || !projectDetails.isDirectory()) throw new Error('Project workspace scope must be a directory without symlinks.');
    return projectRoot;
  }

  private async safeTarget(scope: ProjectWorkspaceScope, relativePath: string, allowMissing: boolean): Promise<string> {
    const projectRoot = await this.ensureProjectRoot(scope);
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (normalized === '' || normalized.split('/').some((part) => part === '.' || part === '..' || part === '')) throw new Error('File paths must stay within the project workspace.');
    const target = path.resolve(projectRoot, normalized);
    if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) throw new Error('File paths must stay within the project workspace.');
    await this.rejectSymlinks(projectRoot, normalized, allowMissing);
    return target;
  }

  private async rejectSymlinks(projectRoot: string, relativePath: string, allowMissingLeaf: boolean): Promise<void> {
    const parts = relativePath.split(path.sep).filter(Boolean);
    let current = projectRoot;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]!);
      try {
        const details = await lstat(current);
        if (details.isSymbolicLink()) throw new Error('Symlinks are not supported in project workspaces.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf) return;
        throw error;
      }
    }
  }

  private validateScopePart(value: string, label: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid ${label} workspace scope.`);
  }
}
