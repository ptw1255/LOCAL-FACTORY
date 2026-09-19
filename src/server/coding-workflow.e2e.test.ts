import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import { RepositoryWorkspace } from '../repository/workspace.js';
import { GitHubRepositoryClient } from '../repository/github.js';
import { VaultSecretBroker } from '../connections/vault-secret-broker.js';
import { JsonStore } from '../storage/json-store.js';
import { PostgresStore } from '../storage/postgres-store.js';
import { createApp } from './app.js';

async function waitFor(app: Awaited<ReturnType<typeof createApp>>, runId: string, status: string, headers?: Record<string, string>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const payload = app.inject({ method: 'GET', url: `/api/runs/${runId}`, ...(headers === undefined ? {} : { headers }) }).then((response) => response.json() as Record<string, unknown>);
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

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationVaultAddress = process.env.TEST_VAULT_ADDR;
const integrationVaultToken = process.env.TEST_VAULT_TOKEN ?? 'dev-only-token';

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
      const startedRun = started.json() as { id: string; traceId?: string; releaseBundleHash?: string; pinnedAgentVersions?: Record<string, number> };
      const runId = startedRun.id;
      expect(startedRun.traceId).toEqual(expect.any(String));
      expect(startedRun.releaseBundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(startedRun.pinnedAgentVersions).toEqual(expect.objectContaining({ 'request-assessor': expect.any(Number) }));
      expect((await waitFor(app, runId, 'waiting')).status).toBe('waiting');
      let waitingItems: Array<{ status: string; correlationId?: string; idempotencyKey?: string }> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const waitingEvidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
        waitingItems = (waitingEvidence.json() as { items: Array<{ status: string; correlationId?: string; idempotencyKey?: string }> }).items;
        if (waitingItems.some((entry) => entry.status === 'waiting' && entry.correlationId !== undefined)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingItems.some((entry) => entry.status === 'waiting' && entry.correlationId !== undefined)).toBe(true);
      const approvals = await app.inject({ method: 'GET', url: `/api/approvals?runId=${runId}`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' } });
      expect((approvals.json() as { items: Array<{ decision: string; bindingHash: string }> }).items).toEqual([expect.objectContaining({ decision: 'pending', bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
      await app.close();
      const restartedApp = await createApp({ store, repositoryWorkspace, serveStatic: false });
      await store.mutate((state) => {
        const persisted = state.runs.find((candidate) => candidate.id === runId);
        const node = persisted?.workflowDefinition.nodes.find((candidate) => candidate.id === 'prepare');
        if (node === undefined) throw new Error('Prepare node is missing from the persisted run.');
        node.config = { ...node.config, operations: [{ operation: 'create', path: 'generated.txt', content: 'changed-after-review' }] };
      });
      const staleApproval = await restartedApp.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
      expect(staleApproval.statusCode).toBe(409);
      expect((staleApproval.json() as { message: string }).message).toMatch(/no longer valid|changed/i);
      await store.mutate((state) => {
        const persisted = state.runs.find((candidate) => candidate.id === runId);
        const node = persisted?.workflowDefinition.nodes.find((candidate) => candidate.id === 'prepare');
        if (node === undefined) throw new Error('Prepare node is missing from the persisted run.');
        node.config = { ...node.config, operations: [{ operation: 'create', path: 'generated.txt', content: 'generated' }] };
      });
      const approved = await restartedApp.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, headers: { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' }, payload: {} });
      expect(approved.statusCode).toBe(200);
      const completed = await waitFor(restartedApp, runId, 'succeeded');
      expect(completed).toEqual(expect.objectContaining({ releaseBundleHash: startedRun.releaseBundleHash, pinnedAgentVersions: startedRun.pinnedAgentVersions }));
      const evidence = await restartedApp.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const evidenceItems = (evidence.json() as { items: Array<{ unitId: string; status: string; idempotencyKey?: string; correlationId?: string }> }).items;
      expect(evidenceItems.some((entry) => entry.unitId === 'prepare' && entry.status === 'succeeded' && entry.correlationId !== undefined)).toBe(true);
      const prepareSuccesses = evidenceItems.filter((entry) => entry.unitId === 'prepare' && entry.status === 'succeeded');
      expect(prepareSuccesses).toHaveLength(1);
      expect(new Set(prepareSuccesses.map((entry) => entry.idempotencyKey)).size).toBe(1);
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
    await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'coding-fixture', scripts: { test: `node -e "process.stdout.write('fixture-test-ok')"` } }));
    await execFileAsync('git', ['add', 'README.md', 'package.json'], { cwd: repoRoot });
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
      { id: 'check', type: 'repositoryCheck', label: 'Run tests', position: { x: 360, y: 0 }, config: { command: 'npm test' }, unit: defaultWorkUnit('repositoryCheck') },
      { id: 'branch', type: 'repositoryBranch', label: 'Branch', position: { x: 540, y: 0 }, config: { requiresApproval: true, branch: 'factory/change', baseRevision }, unit: defaultWorkUnit('repositoryBranch') },
      { id: 'commit', type: 'repositoryCommit', label: 'Commit', position: { x: 720, y: 0 }, config: { requiresApproval: true, message: 'Apply generated change', paths: ['README.md'] }, unit: defaultWorkUnit('repositoryCommit') },
      { id: 'pr', type: 'repositoryPullRequest', label: 'Open PR', position: { x: 900, y: 0 }, config: { requiresApproval: true, title: 'Generated change', body: 'What: update README\\nWhy: verify factory delivery', head: 'factory/change', base: 'main' }, unit: defaultWorkUnit('repositoryPullRequest') },
      { id: 'ci', type: 'repositoryCi', label: 'Verify CI', position: { x: 1080, y: 0 }, config: { ref: baseRevision, required: ['test'], timeoutMs: 500, intervalMs: 10 }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'output', type: 'output', label: 'Complete', position: { x: 1260, y: 0 }, config: { value: 'delivered' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = workflow.nodes.slice(0, -1).map((node, index) => ({ id: `edge-${node.id}-${workflow.nodes[index + 1]?.id}`, source: node.id, target: workflow.nodes[index + 1]?.id ?? node.id }));
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    let app = await createApp({ store, repositoryWorkspace, githubRepository: github, serveStatic: false });
    let restarted = false;
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: {} });
      const startedRun = started.json() as { id: string; traceId?: string; releaseBundleHash?: string; pinnedAgentVersions?: Record<string, number> };
      const runId = startedRun.id;
      expect(startedRun.releaseBundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(startedRun.pinnedAgentVersions).toEqual({});
      let terminal: Record<string, unknown> | undefined;
      // Repository operations involve real git subprocesses; keep the wait
      // finite but allow normal local scheduling latency.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await app.inject({ method: 'GET', url: `/api/runs/${runId}` }).then((response) => response.json() as Record<string, unknown>);
        if (current.status === 'waiting') {
          if (!restarted) {
            await app.close();
            app = await createApp({ store, repositoryWorkspace, githubRepository: github, serveStatic: false });
            restarted = true;
          }
          const approved = await app.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, payload: {} });
          expect(approved.statusCode).toBe(200);
        } else if (current.status === 'succeeded' || current.status === 'failed') { terminal = current; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const terminalSummary = terminal && {
        status: terminal.status,
        error: terminal.error,
        completedNodeIds: terminal.completedNodeIds,
        activatedNodeIds: terminal.activatedNodeIds,
        approvedNodeIds: terminal.approvedNodeIds,
      };
      expect(terminal?.status, `issue-to-merge terminal run: ${JSON.stringify(terminalSummary)}`).toBe('succeeded');
      expect(restarted).toBe(true);
      expect(githubFetcher).toHaveBeenCalledTimes(4);
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const operations = (evidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items;
      expect(operations.some((entry) => entry.unitId === 'check' && entry.status === 'succeeded' && entry.metadata?.['check.exit_code'] === 0)).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'branch' && entry.status === 'succeeded' && typeof entry.metadata?.['repository.branch'] === 'string' && typeof entry.metadata?.['repository.revision'] === 'string')).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'commit' && entry.status === 'succeeded' && typeof entry.metadata?.['repository.revision'] === 'string')).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'commit' && entry.status === 'succeeded')).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'pr' && entry.status === 'succeeded' && entry.metadata?.['pull_request.number'] === 12 && entry.metadata?.['provider.url'] === 'https://github.com/example/repo/pull/12')).toBe(true);
      expect(operations.some((entry) => entry.unitId === 'ci' && entry.status === 'succeeded' && entry.metadata?.['ci.status'] === 'success' && entry.metadata?.['ci.ref'] === baseRevision)).toBe(true);
      expect(operations.filter((entry) => entry.status === 'succeeded').length).toBeGreaterThanOrEqual(7);
      await expect(readFile(path.join(repoRoot, 'README.md'), 'utf8')).resolves.toBe('source');
    } finally { await app.close(); }
  });

  it('observes an issue-bound action plan through mutation, PR, CI, review, and merge', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-issue-merge-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'coding-fixture', scripts: { test: `node -e "process.stdout.write('fixture-test-ok')"` } }));
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
    const baseRevision = await new Promise<string>((resolve, reject) => execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }, (error, stdout) => error === null ? resolve(stdout.trim()) : reject(error)));
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-issue-merge-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const github = {
      createIssue: vi.fn().mockResolvedValue({ number: 101, title: 'Child task', state: 'open', url: 'https://github.com/example/repo/issues/101' }),
      createOrGetPullRequest: vi.fn().mockResolvedValue({ number: 202, url: 'https://github.com/example/repo/pull/202', head: 'factory/issue-42', base: 'main', state: 'open' }),
      waitForChecks: vi.fn().mockResolvedValue({ ref: 'commit-202', status: 'success', checks: [{ name: 'test', status: 'completed', conclusion: 'success' }], required: ['test'], failures: [] }),
      waitForPullRequestStatus: vi.fn().mockResolvedValue({ number: 202, state: 'open', status: 'approved', approvals: 1, changesRequested: 0, requiredApprovals: 1, reviews: [] }),
      mergePullRequest: vi.fn().mockResolvedValue({ number: 202, merged: true, sha: 'merge-202', message: 'merged' }),
    } as unknown as GitHubRepositoryClient;
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-issue-merge-e2e';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'issue', type: 'repositoryIssue', label: 'Create linked task', position: { x: 180, y: 0 }, config: { operation: 'create', parentIssueNumber: 42, title: 'Child task', body: 'Implement the issue.' }, unit: defaultWorkUnit('repositoryIssue') },
      { id: 'mutate', type: 'repositoryMutation', label: 'Apply plan', position: { x: 360, y: 0 }, config: { capabilities: ['repository.write'], requiresApproval: true, deliveryActionPlan: '{{plan}}' }, unit: defaultWorkUnit('repositoryMutation') },
      { id: 'check', type: 'repositoryCheck', label: 'Run checks', position: { x: 540, y: 0 }, config: { command: 'node --version' }, unit: defaultWorkUnit('repositoryCheck') },
      { id: 'branch', type: 'repositoryBranch', label: 'Branch', position: { x: 720, y: 0 }, config: { requiresApproval: true, branch: '{{plan.branch.name}}', baseRevision: '{{plan.repository.baseRevision}}' }, unit: defaultWorkUnit('repositoryBranch') },
      { id: 'commit', type: 'repositoryCommit', label: 'Commit', position: { x: 900, y: 0 }, config: { requiresApproval: true, message: '{{plan.commit.message}}', paths: '{{plan.commit.paths}}' }, unit: defaultWorkUnit('repositoryCommit') },
      { id: 'pr', type: 'repositoryPullRequest', label: 'Open PR', position: { x: 1080, y: 0 }, config: { requiresApproval: true, title: '{{plan.pullRequest.title}}', body: '{{plan.pullRequest.body}}', head: '{{plan.branch.name}}', base: '{{plan.pullRequest.base}}' }, unit: defaultWorkUnit('repositoryPullRequest') },
      { id: 'ci', type: 'repositoryCi', label: 'Observe CI', position: { x: 1260, y: 0 }, config: { required: ['test'], timeoutMs: 500, intervalMs: 10 }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'review', type: 'repositoryReview', label: 'Observe review', position: { x: 1440, y: 0 }, config: { number: 202, requiredApprovals: 1, timeoutMs: 500, intervalMs: 10 }, unit: defaultWorkUnit('repositoryReview') },
      { id: 'merge', type: 'repositoryMerge', label: 'Merge', position: { x: 1620, y: 0 }, config: { number: 202, method: 'squash', requiresApproval: true }, unit: defaultWorkUnit('repositoryMerge') },
      { id: 'output', type: 'output', label: 'Complete', position: { x: 1800, y: 0 }, config: { value: 'merged' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = workflow.nodes.slice(0, -1).map((node, index) => ({ id: `edge-${node.id}-${workflow.nodes[index + 1]?.id}`, source: node.id, target: workflow.nodes[index + 1]?.id ?? node.id }));
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    const app = await createApp({ store, repositoryWorkspace, githubRepository: github, serveStatic: false });
    const deliveryActionPlan = {
      version: 1,
      issue: { number: 42, title: 'Parent issue', repository: 'example/repo' },
      repository: { owner: 'example', name: 'repo', baseRevision },
      tasks: [{ id: 'implement', title: 'Implement the issue' }],
      mutations: [{ operation: 'replace', path: 'README.md', content: 'generated' }],
      checks: ['node --version'],
      branch: { name: 'factory/issue-42' },
      commit: { message: 'Implement issue 42', paths: ['README.md'] },
      pullRequest: { title: 'Implement issue 42', body: 'What: update README\nWhy: resolve issue 42', base: 'main' },
      source: { agentId: 'luna-executor', model: 'gpt-5.6-luna', artifactId: 'artifact-42' },
      policyVersion: 'delivery-v1',
    };
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: { input: { deliveryActionPlan } } });
      expect(started.statusCode).toBe(200);
      const runId = (started.json() as { id: string }).id;
      let terminal: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const current = await app.inject({ method: 'GET', url: `/api/runs/${runId}` }).then((response) => response.json() as Record<string, unknown>);
        if (current.status === 'waiting') {
          expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, payload: {} })).statusCode).toBe(200);
        } else if (current.status === 'succeeded' || current.status === 'failed') { terminal = current; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(terminal?.status, `issue-to-merge terminal run: ${JSON.stringify(terminal)}`).toBe('succeeded');
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const items = (evidence.json() as { items: Array<{ unitId: string; operation: string; status: string; metadata?: Record<string, unknown> }> }).items;
      for (const unitId of ['delivery-plan', 'issue', 'mutate', 'check', 'branch', 'commit', 'pr', 'ci', 'review', 'merge']) {
        expect(items.some((entry) => entry.unitId === unitId && entry.status === 'succeeded')).toBe(true);
      }
      expect(items.find((entry) => entry.unitId === 'delivery-plan')?.metadata).toEqual(expect.objectContaining({ 'delivery.issue.number': 42, 'delivery.source.model': 'gpt-5.6-luna' }));
      expect(github.createIssue).toHaveBeenCalled();
      expect(github.mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ number: 202, method: 'squash' }));
    } finally {
      await app.close();
    }
  });

  it('routes a failed required CI result into a bounded remediation branch', async () => {
    const githubFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/example/repo/actions/runs/3', output: { text: 'test failed' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/repo/actions/runs/4' }] }), { status: 200 }));
    const github = new GitHubRepositoryClient({ token: 'test-token', owner: 'example', repo: 'repo', fetcher: githubFetcher });
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-ci-route-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-ci-route-e2e';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'ci', type: 'repositoryCi', label: 'Verify CI', position: { x: 180, y: 0 }, config: { ref: 'commit-failed', required: ['test'], timeoutMs: 500, intervalMs: 10, failurePolicy: 'route' }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'repair', type: 'transform', label: 'Prepare remediation', position: { x: 360, y: 120 }, config: { value: 'repair-required', requiresApproval: true }, unit: defaultWorkUnit('transform') },
      { id: 'ci-retry', type: 'repositoryCi', label: 'Verify remediation', position: { x: 540, y: 120 }, config: { ref: 'commit-repaired', required: ['test'], timeoutMs: 500, intervalMs: 10 }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'output', type: 'output', label: 'Route outcome', position: { x: 720, y: 120 }, config: { value: 'remediation-complete' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = [
      { id: 'trigger-ci', source: 'trigger', target: 'ci' },
      { id: 'ci-repair', source: 'ci', target: 'repair', condition: 'failure' },
      { id: 'repair-ci-retry', source: 'repair', target: 'ci-retry' },
      { id: 'ci-retry-output', source: 'ci-retry', target: 'output' },
    ];
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    const app = await createApp({ store, githubRepository: github, serveStatic: false });
    let restartedApp: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: {} });
      const runId = (started.json() as { id: string }).id;
      await waitFor(app, runId, 'waiting');
      // Restart while remediation is waiting for approval. The new app must
      // resume from the durable CI failure without polling the failed check a
      // second time or losing the routed branch.
      await app.close();
      restartedApp = await createApp({ store, githubRepository: github, serveStatic: false });
      const approved = await restartedApp.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, payload: {} });
      expect(approved.statusCode).toBe(200);
      const completed = await waitFor(restartedApp, runId, 'succeeded');
      expect((completed.unitOutputs as { repair?: string }).repair).toBe('repair-required');
      expect(githubFetcher).toHaveBeenCalledTimes(2);
      const evidence = await restartedApp.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const ciEvidence = (evidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items.find((entry) => entry.unitId === 'ci' && entry.status === 'succeeded');
      expect(ciEvidence?.metadata).toEqual(expect.objectContaining({ 'ci.status': 'failure', 'ci.failure.0.name': 'test', 'ci.failure.0.conclusion': 'failure', 'ci.failure.0.url': 'https://github.com/example/repo/actions/runs/3' }));
      const retryEvidence = (evidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items.find((entry) => entry.unitId === 'ci-retry' && entry.status === 'succeeded');
      expect(retryEvidence?.metadata).toEqual(expect.objectContaining({ 'ci.status': 'success', 'ci.ref': 'commit-repaired' }));
    } finally {
      await app.close();
      await restartedApp?.close();
    }
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

  it('blocks path escape and unauthorized repository pushes with inspectable evidence', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-negative-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-negative-state-'));
    const store = new JsonStore(path.join(dataRoot, 'state.json'));
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-negative-e2e';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'escape', type: 'repositoryMutation', label: 'Reject path escape', position: { x: 180, y: 0 }, config: { capabilities: ['repository.write'], operations: [{ operation: 'create', path: '../outside.txt', content: 'blocked' }] }, unit: defaultWorkUnit('repositoryMutation') },
      { id: 'push', type: 'repositoryPush', label: 'Reject unauthorized push', position: { x: 360, y: 0 }, config: { remote: 'evil', allowedRemotes: ['origin'] }, unit: defaultWorkUnit('repositoryPush') },
    ];
    workflow.edges = workflow.nodes.slice(0, -1).map((node, index) => ({ id: `edge-${node.id}-${workflow.nodes[index + 1]?.id}`, source: node.id, target: workflow.nodes[index + 1]?.id ?? node.id }));
    await store.mutate((state) => { state.workflows.push(workflow); state.workflowVersions.push(structuredClone(workflow)); });
    const app = await createApp({ store, repositoryWorkspace, serveStatic: false });
    try {
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflow.id}/runs`, payload: {} });
      const runId = (started.json() as { id: string }).id;
      const failed = await waitFor(app, runId, 'failed');
      expect(String(failed.error)).toMatch(/outside workspace|path/i);
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}` });
      const entries = (evidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items;
      expect(entries.some((entry) => entry.unitId === 'escape' && entry.status === 'failed')).toBe(true);
      const pushWorkflow = structuredClone(workflow);
      pushWorkflow.id = 'workflow-unauthorized-push-e2e';
      pushWorkflow.nodes = [
        { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
        { id: 'push', type: 'repositoryPush', label: 'Reject unauthorized push', position: { x: 180, y: 0 }, config: { remote: 'evil', allowedRemotes: ['origin'] }, unit: defaultWorkUnit('repositoryPush') },
      ];
      pushWorkflow.edges = [{ id: 'edge-trigger-push', source: 'trigger', target: 'push' }];
      await store.mutate((state) => { state.workflows.push(pushWorkflow); state.workflowVersions.push(structuredClone(pushWorkflow)); });
      const pushStarted = await app.inject({ method: 'POST', url: `/api/workflows/${pushWorkflow.id}/runs`, payload: {} });
      const pushRunId = (pushStarted.json() as { id: string }).id;
      await waitFor(app, pushRunId, 'failed');
      const pushEvidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${pushRunId}` });
      const pushEntries = (pushEvidence.json() as { items: Array<{ unitId: string; status: string; metadata?: Record<string, unknown> }> }).items;
      expect(pushEntries.some((entry) => entry.unitId === 'push' && entry.status === 'failed' && entry.metadata?.['repository.policy'] === 'allowedRemotes')).toBe(true);
    } finally { await app.close(); }
  });
});

describe.skipIf(integrationDatabaseUrl === undefined || integrationVaultAddress === undefined)('coding workflow PostgreSQL/Vault integration', () => {
  it('persists the project, artifact, run, telemetry, and Vault reference across app restart', async () => {
    const projectHeaders = { 'x-tenant-id': 'tenant-local', 'x-project-id': 'project-local' };
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-e2e-postgres-repo-'));
    await writeFile(path.join(repoRoot, 'README.md'), 'source');
    const repositoryWorkspace = await RepositoryWorkspace.open(repoRoot);
    const store = new PostgresStore(integrationDatabaseUrl!);
    const vault = new VaultSecretBroker({ address: integrationVaultAddress!, token: integrationVaultToken });
    const app = await createApp({ store, repositoryWorkspace, secretBroker: vault, serveStatic: false });
    let projectId: string | undefined;
    let workflowId: string | undefined;
    let runId: string | undefined;
    let artifactId: string | undefined;
    try {
      const project = await app.inject({ method: 'POST', url: '/api/projects', headers: projectHeaders, payload: { name: `Postgres/Vault E2E ${randomUUID()}` } });
      expect(project.statusCode).toBe(200);
      projectId = project.json<{ id: string }>().id;
      const headers = { 'x-tenant-id': 'tenant-local', 'x-project-id': projectId };

      const files = [
        ['factory.yaml', 'apiVersion: factory.agentic/v1\nkind: Project\nmetadata:\n  id: project-local\n  version: 1\n  name: Local\nspec: {}'],
        ['agents/reviewer.agent.yaml', 'apiVersion: factory.agentic/v1\nkind: Agent\nmetadata:\n  id: reviewer\n  version: 1\n  name: Reviewer\nspec:\n  purpose: Review\n  instructions: Review changes\n  skills: []\n  tools: []\n  model: { routingAlias: default-safe }'],
        ['workflows/review.workflow.yaml', 'apiVersion: factory.agentic/v1\nkind: Workflow\nmetadata:\n  id: review\n  version: 1\n  name: Review\nspec:\n  trigger: manual\n  steps:\n    - id: review\n      kind: agent\n      agent: reviewer'],
      ] as const;
      for (const [filePath, content] of files) {
        expect((await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/files`, headers, payload: { path: filePath, content } })).statusCode).toBe(200);
      }
      const compiled = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/compile`, headers, payload: { environment: 'local' } });
      expect(compiled.statusCode).toBe(200);
      artifactId = compiled.json<{ id: string }>().id;
      expect(artifactId).toMatch(/^sha256:/);

      const secret = `integration-secret-${randomUUID()}`;
      const connection = await app.inject({ method: 'POST', url: '/api/connections', headers, payload: { name: `Vault E2E ${randomUUID()}`, connector: 'OpenAI', environment: 'test', scopes: ['llm:invoke'], secret } });
      expect(connection.statusCode).toBe(200);
      const connectionRecord = connection.json<{ secretRef?: string }>();
      expect(connectionRecord).not.toHaveProperty('secret');
      expect(connectionRecord.secretRef).toBeTruthy();
      await expect(vault.get(connectionRecord.secretRef!)).resolves.toBe(secret);

      const cloned = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/workflows`, headers: projectHeaders, payload: { sourceWorkflowId: 'workflow-agent-intake', name: 'Postgres/Vault run' } });
      expect(cloned.statusCode).toBe(200);
      workflowId = cloned.json<{ id: string }>().id;
      const started = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers, payload: { input: { request: 'Persist this run' } } });
      expect(started.statusCode).toBe(200);
      runId = started.json<{ id: string }>().id;
      const completed = await waitFor(app, runId, 'succeeded', headers);
      expect(completed).toEqual(expect.objectContaining({ status: 'succeeded', projectId, tenantId: 'tenant-local', inputHash: expect.any(String) }));

      const events = await app.inject({ method: 'GET', url: `/api/events?runId=${runId}`, headers });
      expect(events.json<{ items: Array<{ traceId: string; attributes?: Record<string, unknown> }> }>().items.length).toBeGreaterThan(0);
      expect(events.json<{ items: Array<{ traceId: string }> }>().items.every((event) => event.traceId.length > 0)).toBe(true);
      const evidence = await app.inject({ method: 'GET', url: `/api/evidence?runId=${runId}`, headers });
      expect(evidence.json<{ items: Array<{ runId: string; correlationId?: string }> }>().items.some((entry) => entry.runId === runId && entry.correlationId !== undefined)).toBe(true);
      const fileEvents = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/files/events`, headers });
      expect(fileEvents.json<{ items: Array<{ type: string; data?: unknown }> }>().items.some((event) => event.type === 'workspace.file.changed')).toBe(true);
      expect(fileEvents.json<{ items: Array<{ data?: unknown }> }>().items.every((event) => event.data === undefined)).toBe(true);
    } finally {
      await app.close();
    }

    const reopened = new PostgresStore(integrationDatabaseUrl!);
    try {
      const persisted = await reopened.read((state) => ({
        project: projectId === undefined ? undefined : state.projects.find((project) => project.id === projectId),
        run: runId === undefined ? undefined : state.runs.find((run) => run.id === runId),
        artifact: artifactId === undefined ? undefined : state.artifacts.find((artifact) => artifact.id === artifactId),
      }));
      expect(persisted.project?.id).toBe(projectId);
      expect(persisted.run).toEqual(expect.objectContaining({ id: runId, status: 'succeeded' }));
      expect(persisted.artifact).toEqual(expect.objectContaining({ id: artifactId }));
      await expect(reopened.listEvents(runId)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ runId, projectId })]));
      await expect(reopened.listEvidence({ runId, tenantId: 'tenant-local', projectId })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ runId, projectId })]));
    } finally {
      await reopened.close();
    }
  });
});
