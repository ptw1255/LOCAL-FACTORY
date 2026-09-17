import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProjectWorkspace } from './project-workspace.js';

describe('ProjectWorkspace filesystem source store', () => {
  it('isolates tenant/project files, supports directories, and restores deleted files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-'));
    const workspace = new ProjectWorkspace(root);
    const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
    const otherScope = { tenantId: 'tenant-a', projectId: 'project-b' };

    expect((await workspace.createDirectory(scope, 'workflows')).status).toBe('created');
    const created = await workspace.save(scope, 'workflows/main.workflow.yaml', 'version: 1');
    expect(created.status).toBe('saved');
    expect((await workspace.read(scope, 'workflows/main.workflow.yaml'))?.content).toBe('version: 1');
    expect((await workspace.list(otherScope)).files).toHaveLength(0);
    await expect(workspace.save(scope, 'workflows/main.workflow.yaml', 'version: 2', 'stale')).resolves.toEqual({ status: 'conflict' });

    const removed = await workspace.remove(scope, 'workflows/main.workflow.yaml');
    expect(removed?.trashId).toMatch(/^trash-/);
    await expect(workspace.read(scope, 'workflows/main.workflow.yaml')).resolves.toBeUndefined();
    expect((await workspace.restore(scope, removed!.trashId))?.content).toBe('version: 1');
  });

  it('rejects symlink traversal and does not enumerate symlink targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-links-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    const workspace = new ProjectWorkspace(root);
    const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
    const projectRoot = path.join(root, scope.tenantId, scope.projectId);
    await workspace.createDirectory(scope, 'links');
    await symlink(path.join(outside, 'secret.txt'), path.join(projectRoot, 'links', 'secret.txt'));
    await expect(workspace.read(scope, 'links/secret.txt')).rejects.toThrow(/symlinks are not supported/i);
    expect((await workspace.list(scope)).files).toHaveLength(0);
  });

  it('preflights batch hashes so a conflict does not partially apply files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-batch-'));
    const workspace = new ProjectWorkspace(root);
    const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
    const first = await workspace.save(scope, 'workflows/main.workflow.yaml', 'version: 1');
    const second = await workspace.save(scope, 'units/main.unit.yaml', 'version: 1');
    const result = await workspace.saveMany(scope, [
      { path: 'workflows/main.workflow.yaml', content: 'version: 2', expectedSha256: first.file?.sha256 },
      { path: 'units/main.unit.yaml', content: 'version: 2', expectedSha256: 'stale' },
    ]);
    expect(result).toEqual({ status: 'conflict' });
    expect((await workspace.read(scope, 'workflows/main.workflow.yaml'))?.content).toBe('version: 1');
    expect((await workspace.read(scope, 'units/main.unit.yaml'))?.content).toBe('version: 1');
    const saved = await workspace.saveMany(scope, [
      { path: 'workflows/main.workflow.yaml', content: 'version: 2', expectedSha256: first.file?.sha256 },
      { path: 'units/main.unit.yaml', content: 'version: 2', expectedSha256: second.file?.sha256 },
    ]);
    expect(saved.status).toBe('saved');
    expect(saved.files?.map((file) => file.content)).toEqual(['version: 2', 'version: 2']);
  });

  it('treats a null expected hash as a create-only precondition', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-create-race-'));
    const workspace = new ProjectWorkspace(root);
    const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
    await workspace.save(scope, 'workflow.yaml', 'version: 1');
    const conflict = await workspace.saveMany(scope, [
      { path: 'workflow.yaml', content: 'version: 2', expectedSha256: null },
      { path: 'unit.yaml', content: 'version: 2', expectedSha256: null },
    ]);
    expect(conflict).toEqual({ status: 'conflict' });
    expect((await workspace.read(scope, 'workflow.yaml'))?.content).toBe('version: 1');
    expect(await workspace.read(scope, 'unit.yaml')).toBeUndefined();
  });

  it('rejects symlinked tenant and project scopes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-scope-links-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'factory-workspace-scope-outside-'));
    const workspace = new ProjectWorkspace(root);
    const tenant = path.join(root, 'tenant-a');
    await symlink(outside, tenant);
    await expect(workspace.list({ tenantId: 'tenant-a', projectId: 'project-a' })).rejects.toThrow(/symlink/i);
  });
});
