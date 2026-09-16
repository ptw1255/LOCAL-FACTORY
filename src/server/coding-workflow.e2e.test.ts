import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import { RepositoryWorkspace } from '../repository/workspace.js';
import { GitHubRepositoryClient } from '../repository/github.js';
import { JsonStore } from '../storage/json-store.js';
import { createApp } from './app.js';

async function waitFor(app: Awaited<ReturnType<typeof createApp>>, runId: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const payload = app.inject({ method: 'GET', url: `/api/runs/${runId}` }).then((response) => response.json() as Record<string, unknown>);
    const current = await payload;
    last = current;
    if (current.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run did not reach ${status}; last status was ${String(last?.status)}: ${String(last?.error ?? '')}`);
}

const execFileAsync = (file: string, args: string[], options: { cwd?: string } = {}) => new Promise<void>((resolve, reject) => {
  execFile(file, args, options, (error) => error === null ? resolve() : reject(error));
});

describe('coding workflow API', () => {
  it('executes an isolated mutation, approval, evidence, and terminal path', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-repo-'));
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-coding-e2e';
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Prepare node is missing.');
    prepare.type = 'repositoryMutation';
    prepare.label = 'Apply approved change';
    prepare.config = { capabilities: ['repository.write'], requiresApproval: true, operations: [{ operation: 'create', path: 'generated.txt', content: 'generated' }] };
    prepare.unit = defaultWorkUnit('repositoryMutation');
    await store.mutate((state) => {
      state.workflows.push(workflow);
      state.workflowVersions.push(structuredClone(workflow));
    });
    const app = await createApp({ store, repositoryWorkspace, serveStatic: false });
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
      expect(started.statusCode).toBe(200);
      const runId = (started.json() as { id: string }).id;
      expect((await waitFor(app, runId, 'waiting')).status).toBe('waiting');
      const waitingEvidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      expect((waitingEvidence.json() as { items: Array<{ status: string }> }).items.some((entry) => entry.status === 'waiting')).toBe(true);
      await app.close();
      const restartedApp = await createApp({ store, repositoryWorkspace, serveStatic: false });
      const approved = await restartedApp.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
      expect(approved.statusCode).toBe(200);
      expect((await waitFor(restartedApp, runId, 'succeeded')).status).toBe('succeeded');
      const evidence = await restartedApp.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      expect((evidence.json() as { items: Array<{ unitId: string; status: string }> }).items.some((entry) => entry.unitId === 'prepare' && entry.status === 'succeeded')).toBe(true);
      await expect(readFile(path.join(repoRoot, 'generated.txt'), 'utf8')).rejects.toThrow();
      await restartedApp.close();
    } finally {
      await app.close();
    }
  });

  it('drives branch, commit, pull request, and CI through bounded approvals', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-git-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
    const baseRevision = await new Promise<string>((resolve, reject) => execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }, (error, stdout) => error === null ? resolve(stdout.trim()) : reject(error)));
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const githubFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('[]', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 12, html_url: 'https://github.com/example/repo/pull/12', head: { ref: 'factory/change' }, base: { ref: 'main' }, state: 'open' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'queued', conclusion: null }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }), { status: 200 }));
    const github = new GitHubRepositoryClient({ token: 'test-token', owner: 'example', repo: 'repo', fetcher: githubFetcher });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-git-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-git-e2e';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'mutate', type: 'repositoryMutation', label: 'Edit', position: { x: 180, y: 0 }, config: { capabilities: ['repository.write'], requiresApproval: true, operations: [{ operation: 'replace', path: 'README.md', content: 'generated' }] }, unit: defaultWorkUnit('repositoryMutation') },
      { id: 'branch', type: 'repositoryBranch', label: 'Branch', position: { x: 360, y: 0 }, config: { requiresApproval: true, branch: 'factory/change', baseRevision }, unit: defaultWorkUnit('repositoryBranch') },
      { id: 'commit', type: 'repositoryCommit', label: 'Commit', position: { x: 540, y: 0 }, config: { requiresApproval: true, message: 'Apply generated change', paths: ['README.md'] }, unit: defaultWorkUnit('repositoryCommit') },
      { id: 'pr', type: 'repositoryPullRequest', label: 'Open PR', position: { x: 720, y: 0 }, config: { requiresApproval: true, title: 'Generated change', body: 'What: update README\\nWhy: verify factory delivery', head: 'factory/change', base: 'main' }, unit: defaultWorkUnit('repositoryPullRequest') },
      { id: 'ci', type: 'repositoryCi', label: 'Verify CI', position: { x: 900, y: 0 }, config: { ref: baseRevision, required: ['test'], timeoutMs: 500, intervalMs: 10 }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'output', type: 'output', label: 'Complete', position: { x: 1080, y: 0 }, config: { value: 'delivered' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = workflow.nodes.slice(0, -1).map((node, index) => ({ id: `edge-${node.id}-${workflow.nodes[index + 1]?.id}`, source: node.id, target: workflow.nodes[index + 1]?.id ?? node.id }));
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    const app = await createApp({ store, repositoryWorkspace, githubRepository: github, serveStatic: false });
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: {} });
      const runId = (started.json() as { id: string }).id;
      let terminal: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = await app.inject({ method: 'GET', url: `/api/runs/${runId}` }).then((response) => response.json() as Record<string, unknown>);
        if (current.status === 'waiting') {
          const approved = await app.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, payload: {} });
          expect(approved.statusCode).toBe(200);
        } else if (current.status === 'succeeded' || current.status === 'failed') { terminal = current; break; }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(terminal?.status).toBe('succeeded');
      expect(githubFetcher).toHaveBeenCalledTimes(4);
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const operations = (evidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items;
      expect(operations.some((entry) => entry.unitId === 'commit' && entry.status === 'succeeded')).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'pr' && entry.status === 'succeeded' && entry.metadata?.['pull_request.number'] === 12 && entry.metadata?.['provider.url'] === 'https://github.com/example/repo/pull/12')).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'ci' && entry.status === 'succeeded' && entry.metadata?.['ci.status'] === 'success' && entry.metadata?.['ci.ref'] === baseRevision)).toBe(true);
      await expect(readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toBe('source');
    } finally { await app.close(); }
  });

  it('routes a failed required CI result into a bounded remediation branch', async () => {
    const githubFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/example/repo/actions/runs/3', output: { text: 'test failed' } }] }), { status: 200 }));
    const github = new GitHubRepositoryClient({ token: 'test-token', owner: 'example', repo: 'repo', fetcher: githubFetcher });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-ci-route-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-ci-route-e2e';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'ci', type: 'repositoryCi', label: 'Verify CI', position: { x: 180, y: 0 }, config: { ref: 'commit-failed', required: ['test'], timeoutMs: 500, intervalMs: 10, failurePolicy: 'route' }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'repair', type: 'transform', label: 'Prepare remediation', position: { x: 360, y: 120 }, config: { value: 'repair-required' }, unit: defaultWorkUnit('transform') },
      { id: 'output', type: 'output', label: 'Route outcome', position: { x: 540, y: 120 }, config: { value: 'remediation-required' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = [
      { id: 'trigger-ci', source: 'trigger', target: 'ci' },
      { id: 'ci-repair', source: 'ci', target: 'repair', condition: 'failure' },
      { id: 'repair-output', source: 'repair', target: 'output' },
    ];
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    const app = await createApp({ store, githubRepository: github, serveStatic: false });
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: {} });
      const runId = (started.json() as { id: string }).id;
      const completed = await waitFor(app, runId, 'succeeded');
      expect((completed.unitOutputs as { repair?: string }).repair).toBe('repair-required');
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const ciEvidence = (evidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items.find((entry) => entry.unitId === 'ci' && entry.status === 'succeeded');
      expect(ciEvidence?.metadata).toEqual(expect.objectContaining({ 'ci.status': 'failure', 'ci.failure.0.name': 'test', 'ci.failure.0.conclusion': 'failure', 'ci.failure.0.url': 'https://github.com/example/repo/actions/runs/3' }));
    } finally { await app.close(); }
  });

  it('requires commits to bind selected paths to an upstream patch artifact', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-patch-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-patch-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-patch-binding-e2e';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'mutate', type: 'repositoryMutation', label: 'Edit', position: { x: 180, y: 0 }, config: { capabilities: ['repository.write'], operations: [{ operation: 'create', path: 'generated.txt', content: 'generated' }] }, unit: defaultWorkUnit('repositoryMutation') },
      { id: 'patch', type: 'repositoryPatch', label: 'Capture patch', position: { x: 360, y: 0 }, config: {}, unit: defaultWorkUnit('repositoryPatch') },
      { id: 'commit', type: 'repositoryCommit', label: 'Commit', position: { x: 540, y: 0 }, config: { message: 'Apply generated change', paths: ['generated.txt'], requirePatchArtifact: true }, unit: defaultWorkUnit('repositoryCommit') },
      { id: 'output', type: 'output', label: 'Complete', position: { x: 720, y: 0 }, config: { value: 'delivered' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = workflow.nodes.slice(0, -1).map((node, index) => ({ id: `edge-${node.id}-${workflow.nodes[index + 1]?.id}`, source: node.id, target: workflow.nodes[index + 1]?.id ?? node.id }));
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    const app = await createApp({ store, repositoryWorkspace, serveStatic: false });
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: {} });
      const runId = (started.json() as { id: string }).id;
      const completed = await waitFor(app, runId, 'succeeded');
      expect(completed.status).toBe('succeeded');
      expect((completed.unitOutputs as { patch?: { changedPaths?: string[] } }).patch?.changedPaths).toContain('generated.txt');
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      expect((evidence.json() as { items: Array<{ unitId: string; status: string }> }).items.some((entry) => entry.unitId === 'commit' && entry.status === 'succeeded')).toBe(true);
    } finally { await app.close(); }
  });
});
