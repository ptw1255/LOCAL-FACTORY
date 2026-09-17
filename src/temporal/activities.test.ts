import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultWorkUnit } from '../domain/catalog.js';
import { seedWorkflow } from '../domain/seed.js';
import { WorkUnitTimeoutError } from '../runtime/work-unit-dispatcher.js';
import { configureTemporalGitHubRepository, configureTemporalModelProviders, configureTemporalObservabilitySink, configureTemporalRepositoryWorkspace, executeNodeActivity, linkTemporalCancellation, TemporalActivityUnsupportedError } from './activities.js';
import { RepositoryWorkspace } from '../repository/workspace.js';

const execFileAsync = (file: string, args: string[], options: { cwd?: string } = {}) => new Promise<void>((resolve, reject) => {
  execFile(file, args, options, (error) => error === null ? resolve() : reject(error));
});

describe('Temporal node activities', () => {
  it('executes deterministic nodes through the WorkUnit contract', async () => {
    const result = await executeNodeActivity({
      runId: 'run-temporal',
      traceId: 'trace-temporal',
      sequence: 2,
      nodeId: 'normalize',
      nodeType: 'code',
      label: 'Normalize',
      config: { operation: 'uppercase', value: 'hello' },
      inputs: ['input'],
      unit: { ...defaultWorkUnit('code'), inputSchema: 'string', outputSchema: 'string' },
    });
    expect(result).toMatchObject({
      nodeId: 'normalize',
      result: 'HELLO',
      lifecycle: {
        runId: 'run-temporal',
        nodeId: 'normalize',
        traceId: 'trace-temporal',
        sequence: 2,
        status: 'succeeded',
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('enforces output schemas before Temporal completion', async () => {
    await expect(executeNodeActivity({
      runId: 'run-temporal',
      nodeId: 'parse',
      nodeType: 'code',
      label: 'Parse',
      config: { operation: 'json.parse', value: '{"ok":true}' },
      unit: { ...defaultWorkUnit('code'), outputSchema: 'string' },
    })).rejects.toThrow('output');
  });

  it('reports started and succeeded lifecycle records to the configured sink', async () => {
    const lifecycle: Array<{ status: string; traceId: string; spanId: string }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push(record); } });
    try {
      await executeNodeActivity({
        runId: 'run-sink',
        traceId: 'trace-sink',
        nodeId: 'normalize',
        nodeType: 'code',
        label: 'Normalize',
        config: { operation: 'uppercase', value: 'hello' },
        unit: defaultWorkUnit('code'),
      });
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle.map((record) => record.status)).toEqual(['started', 'succeeded']);
    expect(lifecycle.every((record) => record.traceId === 'trace-sink' && record.spanId.length === 16)).toBe(true);
  });

  it('preserves a non-first Temporal attempt in lifecycle records', async () => {
    const lifecycle: Array<{ status: string; attempt: number }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push(record); } });
    try {
      await executeNodeActivity({
        runId: 'run-retry',
        nodeId: 'normalize',
        nodeType: 'code',
        label: 'Normalize',
        config: { operation: 'uppercase', value: 'retry' },
        attempt: 3,
        unit: defaultWorkUnit('code'),
      });
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle.map((record) => record.attempt)).toEqual([3, 3]);
  });

  it('reports a failed lifecycle when activity execution rejects', async () => {
    const lifecycle: Array<{ status: string; error?: string }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push(record); } });
    try {
      await expect(executeNodeActivity({
        runId: 'run-failed-sink',
        traceId: 'trace-failed-sink',
        nodeId: 'unsupported',
        nodeType: 'code',
        label: 'Unsupported',
        config: { operation: 'not-allowed' },
        unit: defaultWorkUnit('code'),
      })).rejects.toThrow('Unsupported deterministic code operation');
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle.map((record) => record.status)).toEqual(['started', 'failed']);
    expect(lifecycle[1]?.error).toContain('Unsupported deterministic code operation');
  });

  it('fails closed for unsupported Temporal node types instead of returning a placeholder result', async () => {
    const error = await executeNodeActivity({
      runId: 'run-unsupported',
      nodeId: 'repository',
      nodeType: 'repositoryUnknown',
      label: 'Repository mutation',
      config: { operations: [] },
      unit: defaultWorkUnit('repositoryUnknown'),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TemporalActivityUnsupportedError);
    expect(error).toMatchObject({ code: 'TEMPORAL_ACTIVITY_UNSUPPORTED', nodeType: 'repositoryUnknown' });
  });

  it('executes a bounded agent loop through a configured Temporal provider adapter', async () => {
    const agent = structuredClone(seedWorkflow.agents[0]!);
    agent.model = { provider: 'fake', model: 'fake-v1', capabilities: ['text'] };
    agent.limits.maxIterations = 2;
    const provider = {
      provider: 'fake',
      capabilities: ['text'] as const,
      chat: vi.fn(async ({ agent: requestedAgent, goal }: { agent: typeof agent; goal: string; signal: AbortSignal; traceId?: string }) => ({ content: `${requestedAgent.id}:${goal}`, model: requestedAgent.model.model ?? 'fake-v1' })),
    };
    configureTemporalModelProviders({ clients: new Map([['fake', provider]]) });
    try {
      const activity = await executeNodeActivity({
        runId: 'run-agent',
        traceId: 'trace-agent',
        nodeId: 'agent',
        nodeType: 'agentLoop',
        label: 'Agent',
        config: { agent, goal: 'Assess this change', maxIterations: 2 },
        unit: defaultWorkUnit('agentLoop'),
      });
      expect(activity).toMatchObject({ result: { iterations: 2, outcome: 'bounded-completion', output: 'request-assessor:Assess this change', agentId: 'request-assessor', agentVersion: 1, provider: 'fake', model: 'fake-v1' }, lifecycle: { agentId: 'request-assessor', agentVersion: 1 } });
      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(provider.chat).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'trace-agent', goal: 'Assess this change' }));
    } finally {
      configureTemporalModelProviders();
    }
  });

  it('uses bounded fallback routes and fails closed for undeclared Temporal tools', async () => {
    const agent = structuredClone(seedWorkflow.agents[0]!);
    agent.model = {
      provider: 'primary', model: 'primary-v1', routes: [
        { provider: 'primary', model: 'primary-v1' },
        { provider: 'secondary', model: 'secondary-v1' },
      ], routing: { strategy: 'fallback', maxAttempts: 2 },
    };
    const primary = { provider: 'primary', capabilities: ['text'] as const, chat: vi.fn(async () => { throw new Error('primary unavailable'); }) };
    const secondary = { provider: 'secondary', capabilities: ['text'] as const, chat: vi.fn(async () => ({ content: 'fallback', model: 'secondary-v1' })) };
    configureTemporalModelProviders({ clients: new Map([['primary', primary], ['secondary', secondary]]) });
    try {
      await expect(executeNodeActivity({
        runId: 'run-agent-fallback', nodeId: 'agent', nodeType: 'agentLoop', label: 'Agent',
        config: { agent, goal: 'Fallback', maxIterations: 1 }, unit: defaultWorkUnit('agentLoop'),
      })).resolves.toMatchObject({ result: { provider: 'secondary', output: 'fallback', routeIndex: 1 } });
      expect(primary.chat).toHaveBeenCalledOnce();
      expect(secondary.chat).toHaveBeenCalledOnce();
    } finally {
      configureTemporalModelProviders();
    }

    const toolAgent = structuredClone(seedWorkflow.agents[0]!);
    toolAgent.model = { provider: 'tool-provider', model: 'tool-v1' };
    const toolProvider = { provider: 'tool-provider', capabilities: ['text', 'tools'] as const, chat: vi.fn(async () => ({ content: '', model: 'tool-v1', toolCalls: [{ callId: 'call-1', name: 'not-declared', arguments: '{}' }] })) };
    configureTemporalModelProviders({ clients: new Map([['tool-provider', toolProvider]]) });
    try {
      await expect(executeNodeActivity({
        runId: 'run-agent-tool-policy', nodeId: 'agent', nodeType: 'agentLoop', label: 'Agent',
        config: { agent: toolAgent, goal: 'Tool policy', maxIterations: 1 }, unit: defaultWorkUnit('agentLoop'),
      })).rejects.toThrow('requested undeclared tool');
    } finally {
      configureTemporalModelProviders();
    }
  });

  it('completes an approval activity after the workflow signal is received', async () => {
    const lifecycle: Array<{ status: string; nodeId: string }> = [];
    configureTemporalObservabilitySink({ record: (record) => { lifecycle.push({ status: record.status, nodeId: record.nodeId }); } });
    try {
      await expect(executeNodeActivity({
        runId: 'run-approval',
        nodeId: 'approve',
        nodeType: 'approval',
        label: 'Approve',
        config: {},
        unit: defaultWorkUnit('approval'),
      })).resolves.toMatchObject({ nodeId: 'approve', result: true });
    } finally {
      configureTemporalObservabilitySink(undefined);
    }
    expect(lifecycle).toEqual([{ status: 'started', nodeId: 'approve' }, { status: 'succeeded', nodeId: 'approve' }]);
  });

  it('executes evaluator modes and enforces threshold failures', async () => {
    await expect(executeNodeActivity({
      runId: 'run-evaluator',
      nodeId: 'score',
      nodeType: 'evaluator',
      label: 'Score',
      config: { mode: 'fieldEquals', field: 'status', expected: 'ready', threshold: 1 },
      inputs: [{ status: 'ready' }],
      unit: defaultWorkUnit('evaluator'),
    })).resolves.toMatchObject({ result: { score: 1, threshold: 1, passed: true, mode: 'fieldEquals' } });
    await expect(executeNodeActivity({
      runId: 'run-evaluator-failed',
      nodeId: 'score',
      nodeType: 'evaluator',
      label: 'Score',
      config: { mode: 'exists', threshold: 1, failOnThreshold: true },
      inputs: [null],
      unit: defaultWorkUnit('evaluator'),
    })).rejects.toThrow('Evaluator threshold failed');
  });

  it('executes repository checks through the configured Temporal workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-check-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const workspace = await RepositoryWorkspace.open(directory);
    configureTemporalRepositoryWorkspace(workspace);
    try {
      await expect(executeNodeActivity({
        runId: 'run-repository-check',
        nodeId: 'check',
        nodeType: 'repositoryCheck',
        label: 'Run tests',
        config: { command: 'npm test' },
        unit: defaultWorkUnit('repositoryCheck'),
      })).resolves.toMatchObject({ result: { command: 'npm test', exitCode: 0, required: true, promotionBlocked: false, timedOut: false } });
    } finally {
      configureTemporalRepositoryWorkspace(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs repository checks in a persistent run-scoped workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-check-isolation-'));
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-run-root-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'run-marker\', \'created\')"' } }));
    const workspace = await RepositoryWorkspace.open(directory);
    configureTemporalRepositoryWorkspace(workspace, { runRoot });
    try {
      await expect(executeNodeActivity({
        runId: 'run-repository-check-isolation', nodeId: 'check', nodeType: 'repositoryCheck', label: 'Run tests', config: { command: 'npm test' }, unit: defaultWorkUnit('repositoryCheck'),
      })).resolves.toMatchObject({ result: { exitCode: 0 } });
      await expect(import('node:fs/promises').then(({ readFile }) => readFile(path.join(directory, 'run-marker'), 'utf8'))).rejects.toThrow();
      await expect(import('node:fs/promises').then(({ readFile }) => readFile(path.join(runRoot, 'run-run-repository-check-isolation', 'run-marker'), 'utf8'))).resolves.toBe('created');
    } finally {
      configureTemporalRepositoryWorkspace(undefined);
      await rm(directory, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('executes repository mutation and patch activities in the same isolated run workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-mutation-'));
    const runRoot = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-mutation-root-'));
    await writeFile(path.join(directory, 'README.md'), 'before');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.email', 'factory@example.test'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.name', 'Factory Test'], { cwd: directory });
    await execFileAsync('git', ['add', 'README.md'], { cwd: directory });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
    const workspace = await RepositoryWorkspace.open(directory);
    configureTemporalRepositoryWorkspace(workspace, { runRoot });
    try {
      await expect(executeNodeActivity({
        runId: 'run-repository-mutation', nodeId: 'mutate', nodeType: 'repositoryMutation', label: 'Edit',
        config: { capabilities: ['repository.write'], operations: [{ operation: 'replace', path: 'README.md', content: 'after' }] }, unit: defaultWorkUnit('repositoryMutation'),
      })).resolves.toMatchObject({ result: { results: [{ operation: 'replace', path: 'README.md' }], rolledBack: false } });
      await expect(executeNodeActivity({
        runId: 'run-repository-mutation', nodeId: 'patch', nodeType: 'repositoryPatch', label: 'Patch', config: {}, unit: defaultWorkUnit('repositoryPatch'),
      })).resolves.toMatchObject({ result: { changedPaths: ['README.md'] } });
      const patch = await executeNodeActivity({
        runId: 'run-repository-mutation', nodeId: 'patch', nodeType: 'repositoryPatch', label: 'Patch', config: {}, unit: defaultWorkUnit('repositoryPatch'),
      });
      await expect(executeNodeActivity({
        runId: 'run-repository-mutation', nodeId: 'commit', nodeType: 'repositoryCommit', label: 'Commit',
        config: { message: 'Apply change', paths: ['README.md'], requirePatchArtifact: true }, unit: defaultWorkUnit('repositoryCommit'), inputs: [patch.result],
      })).resolves.toMatchObject({ result: { branch: 'main', revision: expect.any(String) } });
      await expect(import('node:fs/promises').then(({ readFile }) => readFile(path.join(directory, 'README.md'), 'utf8'))).resolves.toBe('before');
    } finally {
      configureTemporalRepositoryWorkspace(undefined);
      await rm(directory, { recursive: true, force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('dispatches Temporal pull request, review, merge, and CI adapters through the configured GitHub client', async () => {
    const pullRequest = { number: 42, url: 'https://github.com/example/repo/pull/42', head: 'factory/change', base: 'main', state: 'open' };
    const github = {
      createOrGetPullRequest: vi.fn(async () => pullRequest),
      waitForPullRequestStatus: vi.fn(async () => ({ number: 42, state: 'open' as const, approvals: 1, changesRequested: 0, reviews: [], status: 'approved' as const, requiredApprovals: 1 })),
      mergePullRequest: vi.fn(async () => ({ number: 42, merged: true, sha: 'abc123', message: 'Merged' })),
      waitForChecks: vi.fn(async () => ({ ref: 'abc123', status: 'success' as const, checks: [], required: [], failures: [] })),
    };
    configureTemporalGitHubRepository(github);
    try {
      await expect(executeNodeActivity({
        runId: 'run-github-lifecycle', nodeId: 'pr', nodeType: 'repositoryPullRequest', label: 'Open PR',
        config: { title: 'Change', body: 'Body', head: 'factory/change', base: 'main' }, unit: defaultWorkUnit('repositoryPullRequest'),
      })).resolves.toMatchObject({ result: { number: 42, head: 'factory/change' } });
      await expect(executeNodeActivity({
        runId: 'run-github-lifecycle', nodeId: 'review', nodeType: 'repositoryReview', label: 'Review',
        config: { number: 42, requiredApprovals: 1 }, unit: defaultWorkUnit('repositoryReview'),
      })).resolves.toMatchObject({ result: { status: 'approved' } });
      await expect(executeNodeActivity({
        runId: 'run-github-lifecycle', nodeId: 'merge', nodeType: 'repositoryMerge', label: 'Merge',
        config: { number: 42, method: 'squash' }, unit: defaultWorkUnit('repositoryMerge'),
      })).resolves.toMatchObject({ result: { merged: true } });
      await expect(executeNodeActivity({
        runId: 'run-github-lifecycle', nodeId: 'ci', nodeType: 'repositoryCi', label: 'CI',
        config: { ref: 'abc123', required: ['checks'] }, unit: defaultWorkUnit('repositoryCi'),
      })).resolves.toMatchObject({ result: { status: 'success', ref: 'abc123' } });
      expect(github.createOrGetPullRequest).toHaveBeenCalledWith({ title: 'Change', body: 'Body', head: 'factory/change', base: 'main' });
      expect(github.waitForPullRequestStatus).toHaveBeenCalledWith(expect.objectContaining({ number: 42, requiredApprovals: 1 }));
      expect(github.mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ number: 42, method: 'squash' }));
      expect(github.waitForChecks).toHaveBeenCalledWith(expect.objectContaining({ ref: 'abc123', required: ['checks'] }));
    } finally {
      configureTemporalGitHubRepository(undefined);
    }
  });

  it('fails required Temporal repository checks and permits advisory failures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-temporal-check-fail-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(2)"' } }));
    const workspace = await RepositoryWorkspace.open(directory);
    configureTemporalRepositoryWorkspace(workspace);
    try {
      await expect(executeNodeActivity({
        runId: 'run-repository-check-required', nodeId: 'check', nodeType: 'repositoryCheck', label: 'Required check',
        config: { command: 'npm test' }, unit: defaultWorkUnit('repositoryCheck'),
      })).rejects.toThrow('Required repository check failed');
      await expect(executeNodeActivity({
        runId: 'run-repository-check-advisory', nodeId: 'check', nodeType: 'repositoryCheck', label: 'Advisory check',
        config: { command: 'npm test', required: false }, unit: defaultWorkUnit('repositoryCheck'),
      })).resolves.toMatchObject({ result: { exitCode: 2, required: false, promotionBlocked: false } });
    } finally {
      configureTemporalRepositoryWorkspace(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-HTTP(S) URLs before making a Temporal request', async () => {
    await expect(executeNodeActivity({
      runId: 'run-http-policy',
      nodeId: 'request',
      nodeType: 'httpRequest',
      label: 'Request',
      config: { url: 'file:///etc/passwd' },
      unit: defaultWorkUnit('httpRequest'),
    })).rejects.toThrow('only http and https URLs');
  });

  it('enforces WorkUnit timeouts for Temporal activities', async () => {
    await expect(executeNodeActivity({
      runId: 'run-temporal',
      nodeId: 'wait',
      nodeType: 'wait',
      label: 'Wait',
      config: { durationMs: 50 },
      unit: { ...defaultWorkUnit('wait'), timeoutMs: 5 },
    })).rejects.toBeInstanceOf(WorkUnitTimeoutError);
  });

  it('propagates and then detaches Temporal cancellation listeners', () => {
    const source = new AbortController();
    const target = new AbortController();
    const unlink = linkTemporalCancellation(target, source.signal);
    const reason = new Error('worker shutdown');
    source.abort(reason);
    expect(target.signal.aborted).toBe(true);
    expect(target.signal.reason).toBe(reason);

    unlink();
    const secondSource = new AbortController();
    const secondTarget = new AbortController();
    const unlinkSecond = linkTemporalCancellation(secondTarget, secondSource.signal);
    unlinkSecond();
    secondSource.abort(new Error('late shutdown'));
    expect(secondTarget.signal.aborted).toBe(false);
  });
});
