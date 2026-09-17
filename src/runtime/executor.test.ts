import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { defaultWorkUnit } from '../domain/catalog.js';
import { EventService } from '../observability/event-service.js';
import { JsonStore } from '../storage/json-store.js';
import { FileArtifactStore } from '../storage/artifact-store.js';
import { createQueuedRun, LocalWorkflowExecutor, releaseBundleHash } from './executor.js';
import { OpenAIProviderError } from './openai.js';
import type { GitHubRepositoryClient } from '../repository/github.js';

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for executor state.');
}

describe('LocalWorkflowExecutor', () => {
  let store: JsonStore;
  let events: EventService;
  let executor: LocalWorkflowExecutor;

  beforeEach(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-runtime-'));
    store = new JsonStore(path.join(directory, 'state.json'));
    events = new EventService(store);
    executor = new LocalWorkflowExecutor(store, events);
  });

  it('executes the seeded workflow and records correlated events', async () => {
    const run = await executor.start(seedWorkflow);
    await waitFor(async () => {
      const current = await store.read((state) =>
        state.runs.find((candidate) => candidate.id === run.id),
      );
      return current?.status === 'succeeded';
    });

    const completed = await store.read((state) =>
      state.runs.find((candidate) => candidate.id === run.id),
    );
    const recorded = await events.list(run.id);

    expect(completed?.completedNodeIds).toHaveLength(seedWorkflow.nodes.length);
    expect(completed?.costUsd).toBeGreaterThan(0);
    expect(recorded.some((event) => event.type === 'run.succeeded')).toBe(true);
    expect(
      recorded.filter((event) => event.type === 'agent.iteration'),
    ).toHaveLength(3);
    expect(recorded.every((event) => event.traceId === run.traceId)).toBe(true);
    expect(recorded.some((event) => event.signal === 'trace' && event.spanKind === 'agent')).toBe(true);
    expect(recorded.some((event) => event.signal === 'metric')).toBe(true);
    expect(recorded.find((event) => event.type === 'agent.iteration')?.attributes).toEqual(
      expect.objectContaining({ 'openinference.span.kind': 'AGENT', 'agent.id': 'request-assessor' }),
    );
  });

  it('validates and propagates a workflow input through the trigger', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-input-contract';
    workflow.inputSchema = {
      type: 'object',
      required: ['request'],
      properties: { request: { type: 'string', minLength: 3 } },
    };
    workflow.nodes = workflow.nodes.map((node) => ({ ...node, sourcePath: 'workflows/input.workflow.yaml', sourceLine: 12 }));
    const run = await executor.start(workflow, { input: { request: 'Fix login' }, environment: 'staging', deploymentId: 'deployment-input' });
    expect(run).toEqual(expect.objectContaining({ environment: 'staging', deploymentId: 'deployment-input', input: { request: 'Fix login' }, inputHash: expect.any(String) }));
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const completed = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id));
    expect(completed?.unitOutputs.trigger).toEqual({ request: 'Fix login' });
    expect((await events.list(run.id)).find((event) => event.type === 'unit.started')?.attributes).toEqual(expect.objectContaining({ 'source.path': 'workflows/input.workflow.yaml', 'source.line': 12 }));
    await expect(executor.start(workflow, { input: { request: 'x' } })).rejects.toThrow('Workflow input is invalid');
  });

  it('executes deterministic evaluator work units and enforces optional thresholds', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-evaluator';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'value', type: 'transform', label: 'Value', position: { x: 180, y: 0 }, config: { value: { status: 'ok', score: 0.9 } }, unit: defaultWorkUnit('transform') },
      { id: 'evaluate', type: 'evaluator', label: 'Evaluate', position: { x: 360, y: 0 }, config: { mode: 'fieldEquals', field: 'status', expected: 'ok', threshold: 1 }, unit: defaultWorkUnit('evaluator') },
    ];
    workflow.edges = [{ id: 'trigger-value', source: 'trigger', target: 'value' }, { id: 'value-evaluate', source: 'value', target: 'evaluate' }];
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const succeeded = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id));
    expect(succeeded?.unitOutputs.evaluate).toEqual({ score: 1, threshold: 1, passed: true, mode: 'fieldEquals' });
    const failedWorkflow = structuredClone(workflow);
    failedWorkflow.id = 'workflow-evaluator-fail';
    const evaluator = failedWorkflow.nodes.find((node) => node.id === 'evaluate');
    if (evaluator === undefined) throw new Error('Evaluator node is missing.');
    evaluator.config = { mode: 'fieldEquals', field: 'status', expected: 'failed', threshold: 1, failOnThreshold: true };
    const failedRun = await executor.start(failedWorkflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === failedRun.id)))?.status === 'failed');
    const failedEvidence = await events.listEvidence(failedRun.id);
    expect(failedEvidence.some((entry) => entry.unitId === 'evaluate' && entry.status === 'failed' && entry.error?.includes('Evaluator threshold failed'))).toBe(true);
  });

  it('enforces compiled policy rules before dispatching a work unit', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.id = 'workflow-policy-deny';
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'output', type: 'output', label: 'Blocked output', position: { x: 180, y: 0 }, config: { value: 'should-not-run', policyId: 'safe-only', policyRules: [{ effect: 'deny', action: 'output' }] }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = [{ id: 'trigger-output', source: 'trigger', target: 'output' }];
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.unitOutputs.output).toBeUndefined();
    expect((await events.list(run.id)).some((event) => event.type === 'policy.denied' && event.nodeId === 'output')).toBe(true);
  });

  it('waits for and resumes from a human approval', async () => {
    const workflow = structuredClone(seedWorkflow);
    const output = workflow.nodes.find((node) => node.id === 'output');
    if (output === undefined) {
      throw new Error('Seed output node is missing.');
    }
    workflow.nodes.splice(workflow.nodes.indexOf(output), 0, {
      id: 'approval',
      type: 'approval',
      label: 'Approve output',
      position: { x: 1_020, y: 180 },
      config: {},
      unit: defaultWorkUnit('approval'),
    });
    const incoming = workflow.edges.find((edge) => edge.target === 'output');
    if (incoming === undefined) {
      throw new Error('Seed output edge is missing.');
    }
    incoming.target = 'approval';
    workflow.edges.push({
      id: 'approval-output',
      source: 'approval',
      target: 'output',
    });

    const run = await executor.start(workflow);
    await waitFor(async () => {
      const current = await store.read((state) =>
        state.runs.find((candidate) => candidate.id === run.id),
      );
      return current?.status === 'waiting';
    });
    await executor.approve(run.id);
    await waitFor(async () => {
      const current = await store.read((state) =>
        state.runs.find((candidate) => candidate.id === run.id),
      );
      return current?.status === 'succeeded';
    });

    const completed = await store.read((state) =>
      state.runs.find((candidate) => candidate.id === run.id),
    );
    expect(completed?.humanTouchpoints).toBe(1);
    expect(completed?.completedNodeIds).toContain('approval');
    const recorded = await events.list(run.id);
    expect(recorded.filter((event) => event.type === 'node.started' && event.nodeId === 'approval')).toHaveLength(1);
    const approval = await store.read((state) => state.approvals.find((candidate) => candidate.runId === run.id && candidate.nodeId === 'approval'));
    expect(approval).toEqual(expect.objectContaining({ decision: 'approved', bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it('supersedes a pending approval and issues a fresh request', async () => {
    const workflow = structuredClone(seedWorkflow);
    const output = workflow.nodes.find((node) => node.id === 'output');
    if (output === undefined) throw new Error('Seed output node is missing.');
    workflow.nodes.splice(workflow.nodes.indexOf(output), 0, {
      id: 'approval-refresh', type: 'approval', label: 'Refresh approval', position: { x: 1_020, y: 180 }, config: {}, unit: defaultWorkUnit('approval'),
    });
    const incoming = workflow.edges.find((edge) => edge.target === 'output');
    if (incoming === undefined) throw new Error('Seed output edge is missing.');
    incoming.target = 'approval-refresh';
    workflow.edges.push({ id: 'approval-refresh-output', source: 'approval-refresh', target: 'output' });
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'waiting');
    const superseded = await executor.supersede(run.id, { actor: 'test-operator', reason: 'Review context changed.' });
    expect(superseded.status).toBe('queued');
    await waitFor(async () => (await store.read((state) => state.approvals.filter((candidate) => candidate.runId === run.id))).length === 2);
    const approvals = await store.read((state) => state.approvals.filter((candidate) => candidate.runId === run.id));
    expect(approvals.some((approval) => approval.decision === 'superseded' && approval.reason === 'Review context changed.')).toBe(true);
    expect(approvals.some((approval) => approval.decision === 'pending')).toBe(true);
    expect((await events.list(run.id)).some((event) => event.type === 'approval.superseded')).toBe(true);
    await executor.cancel(run.id);
  });

  it('rejects approval after the protected operation changes', async () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.config = { value: 'original', requiresApproval: true };
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'waiting');
    await store.mutate((state) => {
      const current = state.runs.find((candidate) => candidate.id === run.id);
      const node = current?.workflowDefinition.nodes.find((candidate) => candidate.id === 'prepare');
      if (node !== undefined) node.config.value = 'changed-after-review';
    });
    await expect(executor.approve(run.id)).rejects.toThrow('operation changed');
    await executor.cancel(run.id);
  });

  it('records denial as a terminal approval decision', async () => {
    const workflow = structuredClone(seedWorkflow);
    const output = workflow.nodes.find((node) => node.id === 'output');
    if (output === undefined) throw new Error('Seed output node is missing.');
    workflow.nodes.splice(workflow.nodes.indexOf(output), 0, {
      id: 'approval-deny', type: 'approval', label: 'Deny output', position: { x: 1_020, y: 180 }, config: {}, unit: defaultWorkUnit('approval'),
    });
    const incoming = workflow.edges.find((edge) => edge.target === 'output');
    if (incoming === undefined) throw new Error('Seed output edge is missing.');
    incoming.target = 'approval-deny';
    workflow.edges.push({ id: 'approval-deny-output', source: 'approval-deny', target: 'output' });
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'waiting');
    await executor.deny(run.id, { actor: 'test-operator', reason: 'Not ready.' });
    const denied = await store.read((state) => ({ run: state.runs.find((candidate) => candidate.id === run.id), approval: state.approvals.find((candidate) => candidate.runId === run.id) }));
    expect(denied.run?.status).toBe('failed');
    expect(denied.run?.error).toBe('Not ready.');
    expect(denied.approval).toEqual(expect.objectContaining({ decision: 'denied', actor: 'test-operator', reason: 'Not ready.' }));
  });

  it('marks pending approval cancelled when the waiting run is cancelled', async () => {
    const workflow = structuredClone(seedWorkflow);
    const output = workflow.nodes.find((node) => node.id === 'output');
    if (output === undefined) throw new Error('Seed output node is missing.');
    workflow.nodes.splice(workflow.nodes.indexOf(output), 0, {
      id: 'approval-cancel', type: 'approval', label: 'Cancel approval', position: { x: 1_020, y: 180 }, config: {}, unit: defaultWorkUnit('approval'),
    });
    const incoming = workflow.edges.find((edge) => edge.target === 'output');
    if (incoming === undefined) throw new Error('Seed output edge is missing.');
    incoming.target = 'approval-cancel';
    workflow.edges.push({ id: 'approval-cancel-output', source: 'approval-cancel', target: 'output' });
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'waiting');
    await executor.cancel(run.id);
    const cancelled = await store.read((state) => ({ run: state.runs.find((candidate) => candidate.id === run.id), approval: state.approvals.find((candidate) => candidate.runId === run.id) }));
    expect(cancelled.run?.status).toBe('cancelled');
    expect(cancelled.approval).toEqual(expect.objectContaining({ decision: 'cancelled', decidedAt: expect.any(String) }));
    expect((await events.list(run.id)).some((event) => event.type === 'approval.cancelled')).toBe(true);
  });

  it('expires a pending approval as a durable terminal decision', async () => {
    const workflow = structuredClone(seedWorkflow);
    const output = workflow.nodes.find((node) => node.id === 'output');
    if (output === undefined) throw new Error('Seed output node is missing.');
    workflow.nodes.splice(workflow.nodes.indexOf(output), 0, { id: 'approval-expire', type: 'approval', label: 'Expire approval', position: { x: 1_020, y: 180 }, config: {}, unit: defaultWorkUnit('approval') });
    const incoming = workflow.edges.find((edge) => edge.target === 'output');
    if (incoming === undefined) throw new Error('Seed output edge is missing.');
    incoming.target = 'approval-expire';
    workflow.edges.push({ id: 'approval-expire-output', source: 'approval-expire', target: 'output' });
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'waiting');
    await executor.expire(run.id, { actor: 'expiry-test', reason: 'Expired for test.' });
    const expired = await store.read((state) => ({ run: state.runs.find((candidate) => candidate.id === run.id), approval: state.approvals.find((candidate) => candidate.runId === run.id) }));
    expect(expired.run).toEqual(expect.objectContaining({ status: 'failed', error: 'Expired for test.' }));
    expect(expired.approval).toEqual(expect.objectContaining({ decision: 'expired', actor: 'expiry-test', reason: 'Expired for test.' }));
  });

  it('runs deterministic code units before downstream work', async () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'code';
    prepare.config = { operation: 'uppercase', value: 'validated request' };

    const run = await executor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );

    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'unit.completed' && event.nodeId === 'prepare')).toBe(true);
    expect(recorded.find((event) => event.type === 'node.completed' && event.nodeId === 'prepare')?.data?.result).toBe('VALIDATED REQUEST');
    const output = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.unitOutputs.prepare);
    expect(output).toBe('VALIDATED REQUEST');
  });

  it('resolves artifact-backed unit outputs before dispatching downstream work', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-runtime-artifacts-'));
    const artifactStore = new FileArtifactStore(path.join(directory, 'artifacts'));
    const artifactEvents = new EventService(store, { artifactStore, inlineDataBytes: 1_024 });
    const artifactExecutor = new LocalWorkflowExecutor(store, artifactEvents);
    const workflow = structuredClone(seedWorkflow);
    workflow.nodes = workflow.nodes.filter((node) => ['trigger', 'prepare', 'output'].includes(node.id));
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    const output = workflow.nodes.find((node) => node.id === 'output');
    if (prepare === undefined || output === undefined) throw new Error('Seed nodes are missing.');
    prepare.type = 'code';
    prepare.unit = defaultWorkUnit('code');
    prepare.config = { operation: 'identity', value: 'x'.repeat(2_000) };
    output.type = 'code';
    output.unit = defaultWorkUnit('code');
    output.config = { operation: 'identity' };
    workflow.edges = [
      { id: 'trigger-prepare', source: 'trigger', target: 'prepare' },
      { id: 'prepare-output', source: 'prepare', target: 'output' },
    ];

    const run = await artifactExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const persisted = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id));
    expect(persisted?.unitOutputs.prepare).toEqual(expect.objectContaining({ artifactRef: expect.objectContaining({ id: expect.stringMatching(/^artifact:sha256:/) }) }));
    await expect(artifactEvents.resolvePayload(persisted?.unitOutputs.output)).resolves.toEqual('x'.repeat(2_000));
  });

  it('dispatches repository mutations into an isolated workspace', async () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'repositoryMutation';
    prepare.label = 'Prepare repository workspace';
    prepare.config = { capabilities: ['repository.write'], operations: [{ operation: 'create', path: '.factory-run-marker', content: 'created' }] };
    prepare.unit = defaultWorkUnit('repositoryMutation');

    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(process.cwd());
    const isolatedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, repository);
    const run = await isolatedExecutor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );

    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'unit.completed' && event.nodeId === 'prepare')).toBe(true);
    const mutationEvidence = (await events.listEvidence(run.id)).find((evidence) => evidence.unitId === 'prepare' && evidence.status === 'succeeded');
    expect(mutationEvidence?.metadata).toEqual(expect.objectContaining({ 'operation.id': expect.any(String), 'patch.artifact_id': expect.any(String) }));
    await expect(repository.read('.factory-run-marker')).rejects.toThrow();
  });

  it('persists mutation transaction identity and rollback status on failure', async () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'repositoryMutation';
    prepare.label = 'Failing repository transaction';
    prepare.config = {
      capabilities: ['repository.write'],
      operations: [
        { operation: 'replace', path: 'README.md', content: 'temporary mutation' },
        { operation: 'delete', path: 'missing-file-for-rollback' },
      ],
    };
    prepare.unit = defaultWorkUnit('repositoryMutation');
    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(process.cwd());
    const isolatedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, repository);
    const run = await isolatedExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    const mutationFailure = (await events.listEvidence(run.id)).find((entry) => entry.unitId === 'prepare' && entry.status === 'failed');
    expect(mutationFailure?.metadata).toEqual(expect.objectContaining({
      'operation.transaction_id': expect.stringMatching(/^sha256:/),
      'mutation.rolled_back': true,
    }));
  });

  it('rejects repository commits when approved patch content drifts', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'mutate', type: 'repositoryMutation', label: 'Approved edit', position: { x: 180, y: 0 }, config: { capabilities: ['repository.write'], operations: [{ operation: 'replace', path: 'README.md', content: 'approved' }] }, unit: defaultWorkUnit('repositoryMutation') },
      { id: 'patch', type: 'repositoryPatch', label: 'Capture patch', position: { x: 360, y: 0 }, config: {}, unit: defaultWorkUnit('repositoryPatch') },
      { id: 'drift', type: 'repositoryMutation', label: 'Unapproved edit', position: { x: 540, y: 0 }, config: { capabilities: ['repository.write'], operations: [{ operation: 'replace', path: 'README.md', content: 'drifted' }] }, unit: defaultWorkUnit('repositoryMutation') },
      { id: 'commit', type: 'repositoryCommit', label: 'Commit', position: { x: 720, y: 0 }, config: { message: 'Commit approved patch', paths: ['README.md'], requirePatchArtifact: true }, unit: defaultWorkUnit('repositoryCommit') },
    ];
    workflow.edges = workflow.nodes.slice(0, -1).map((node, index) => ({ id: `${node.id}-${workflow.nodes[index + 1]?.id}`, source: node.id, target: workflow.nodes[index + 1]?.id ?? node.id }));
    workflow.edges.push({ id: 'patch-commit', source: 'patch', target: 'commit' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'factory-commit-drift-'));
    const { execFile } = await import('node:child_process');
    const exec = (args: string[]) => new Promise<void>((resolve, reject) => execFile('git', args, { cwd: root }, (error) => error === null ? resolve() : reject(error)));
    await exec(['init', '-b', 'main']);
    await exec(['config', 'user.email', 'factory@example.test']);
    await exec(['config', 'user.name', 'Factory Test']);
    await writeFile(path.join(root, 'README.md'), 'source');
    await exec(['add', 'README.md']);
    await exec(['commit', '-m', 'initial']);
    const source = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(root);
    const isolatedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, source);
    const run = await isolatedExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    const failed = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id));
    expect(failed?.error).toContain('exactly one unambiguous upstream patch artifact');
  });

  it('fails closed when repository mutation capability is not declared', async () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'repositoryMutation';
    prepare.config = { operations: [{ operation: 'create', path: '.factory-denied', content: 'blocked' }] };
    prepare.unit = defaultWorkUnit('repositoryMutation');
    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(process.cwd());
    const isolatedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, repository);
    const run = await isolatedExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.error).toContain('repository.write');
  });

  it('blocks on required repository checks but allows advisory failures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-check-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(1)"' } }));
    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(directory);
    const requiredWorkflow = structuredClone(seedWorkflow);
    const requiredPrepare = requiredWorkflow.nodes.find((node) => node.id === 'prepare');
    if (requiredPrepare === undefined) throw new Error('Seed prepare node is missing.');
    requiredPrepare.type = 'repositoryCheck';
    requiredPrepare.config = { command: 'npm run typecheck' };
    requiredPrepare.unit = defaultWorkUnit('repositoryCheck');
    const requiredExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, repository);
    const requiredRun = await requiredExecutor.start(requiredWorkflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === requiredRun.id)))?.status === 'failed');
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === requiredRun.id)))?.error).toContain('Required repository check failed');

    const advisoryWorkflow = structuredClone(requiredWorkflow);
    const advisoryPrepare = advisoryWorkflow.nodes.find((node) => node.id === 'prepare');
    if (advisoryPrepare === undefined) throw new Error('Seed prepare node is missing.');
    advisoryPrepare.config.required = false;
    const advisoryRun = await requiredExecutor.start(advisoryWorkflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === advisoryRun.id)))?.status === 'succeeded');
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === advisoryRun.id)?.unitOutputs.prepare))).toMatchObject({ required: false, promotionBlocked: false });
  });

  it('records required repository check timeouts as timed-out evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-check-timeout-runtime-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "setTimeout(() => {}, 1000)"' } }));
    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(directory);
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'repositoryCheck';
    prepare.config = { command: 'npm run typecheck', timeoutMs: 20 };
    prepare.unit = defaultWorkUnit('repositoryCheck');
    const checkExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, repository);
    const run = await checkExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'timed_out');
    const failed = (await events.listEvidence(run.id)).find((entry) => entry.unitId === 'prepare' && entry.status === 'timed_out');
    expect(failed).toEqual(expect.objectContaining({ status: 'timed_out', metadata: expect.objectContaining({ 'check.timed_out': true }) }));
  });

  it('links oversized check output to a durable artifact in unit evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-check-artifact-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.stdout.write(\'x\'.repeat(3000))"' } }));
    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(directory);
    const artifactStore = new FileArtifactStore(path.join(directory, 'artifacts'));
    const artifactEvents = new EventService(store, { artifactStore, inlineDataBytes: 1_024 });
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'repositoryCheck';
    prepare.config = { command: 'npm test' };
    prepare.unit = defaultWorkUnit('repositoryCheck');
    const checkExecutor = new LocalWorkflowExecutor(store, artifactEvents, undefined, undefined, repository);
    const run = await checkExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const persistedOutput = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.unitOutputs.prepare);
    expect(persistedOutput).toEqual(expect.objectContaining({ artifactRef: expect.objectContaining({ id: expect.stringMatching(/^artifact:sha256:/) }) }));
    const evidence = (await artifactEvents.listEvidence(run.id)).find((entry) => entry.unitId === 'prepare' && entry.status === 'succeeded');
    expect(evidence?.metadata).toEqual(expect.objectContaining({ 'artifact.payload_id': expect.stringMatching(/^artifact:sha256:/) }));
    await artifactEvents.close();
  });

  it('links oversized failed check output to a durable artifact in failure evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-check-failure-artifact-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.stdout.write(\'x\'.repeat(3000)); process.exit(1)"' } }));
    const repository = await (await import('../repository/workspace.js')).RepositoryWorkspace.open(directory);
    const artifactStore = new FileArtifactStore(path.join(directory, 'artifacts'));
    const artifactEvents = new EventService(store, { artifactStore, inlineDataBytes: 1_024 });
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'repositoryCheck';
    prepare.config = { command: 'npm test' };
    prepare.unit = defaultWorkUnit('repositoryCheck');
    const checkExecutor = new LocalWorkflowExecutor(store, artifactEvents, undefined, undefined, repository);
    const run = await checkExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    const evidence = (await artifactEvents.listEvidence(run.id)).find((entry) => entry.unitId === 'prepare' && entry.status === 'failed');
    expect(evidence?.metadata).toEqual(expect.objectContaining({ 'artifact.payload_id': expect.stringMatching(/^artifact:sha256:/) }));
    await artifactEvents.close();
  });

  it('routes OpenAI agents through the provider-neutral agent lifecycle', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    let receivedTraceId: string | undefined;
    const openai = { chat: async (input: { traceId?: string }) => {
      receivedTraceId = input.traceId;
      return { content: 'hosted result', model: 'gpt-5', promptTokens: 3, completionTokens: 2, requestId: 'req-1' };
    } };
    const hostedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai);
    const run = await hostedExecutor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );
    expect(receivedTraceId).toBe(run.traceId);
    const recorded = await events.list(run.id);
    expect(recorded.find((event) => event.type === 'llm.completed')?.attributes).toEqual(expect.objectContaining({ 'llm.provider': 'openai', 'llm.request_id': 'req-1' }));
  });

  it('routes local OpenAI-compatible agents and preserves the declared provider in telemetry', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'lmstudio', model: 'qwen2.5-coder-7b' };
    let receivedTraceId: string | undefined;
    const compatible = { provider: 'lmstudio', chat: async (input: { traceId?: string }) => {
      receivedTraceId = input.traceId;
      return { content: 'local result', model: 'qwen2.5-coder-7b', promptTokens: 2, completionTokens: 1, requestId: 'local-1' };
    } };
    const compatibleExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, undefined, new Map(), compatible);
    const run = await compatibleExecutor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );
    expect(receivedTraceId).toBe(run.traceId);
    const recorded = await events.list(run.id);
    expect(recorded.find((event) => event.type === 'llm.completed')?.attributes).toEqual(expect.objectContaining({ 'llm.provider': 'lmstudio', 'llm.request_id': 'local-1' }));
  });

  it('resolves registered hosted adapters by provider name', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'gemini', model: 'gemini-2.5-flash' };
    const gemini = { provider: 'gemini', chat: async () => ({ content: 'gemini result', model: 'gemini-2.5-flash', requestId: 'gemini-1' }) };
    const hostedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, undefined, new Map(), undefined, new Map([['gemini', gemini]]));
    const run = await hostedExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const recorded = await events.list(run.id);
    expect(recorded.find((event) => event.type === 'llm.completed')?.attributes).toEqual(expect.objectContaining({ 'llm.provider': 'gemini', 'llm.request_id': 'gemini-1' }));
  });

  it('uses a bounded fallback route when the primary provider is unavailable', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = {
      routing: { strategy: 'fallback', maxAttempts: 2 },
      routes: [
        { provider: 'openai', model: 'gpt-5' },
        { provider: 'ollama', model: 'llama3.2' },
      ],
    };
    const openai = { chat: async () => {
      throw new OpenAIProviderError('server', 'primary unavailable');
    } };
    const ollama = {
      ensureModel: async () => undefined,
      chat: async () => ({ content: 'local fallback', model: 'llama3.2', promptTokens: 2, completionTokens: 3 }),
    };
    const routedExecutor = new LocalWorkflowExecutor(store, events, ollama, undefined, undefined, undefined, openai);
    const run = await routedExecutor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );
    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'llm.route.failed' && event.attributes?.['llm.route.provider'] === 'openai')).toBe(true);
    expect(recorded.some((event) => event.type === 'llm.route.selected' && event.attributes?.['llm.route.provider'] === 'ollama')).toBe(true);
    expect(recorded.find((event) => event.type === 'agent.iteration')?.attributes).toEqual(expect.objectContaining({ 'llm.model_name': 'llama3.2', 'llm.route.index': 1, 'llm.route.strategy': 'fallback' }));
    expect(recorded.find((event) => event.type === 'llm.completed')?.attributes).toEqual(expect.objectContaining({ 'llm.provider': 'ollama', 'llm.model_name': 'llama3.2' }));
  });

  it('runs a bounded text-only ensemble and aggregates route output deterministically', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.limits.maxIterations = 1;
    agent.outputSchema = {};
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agentNode === undefined) throw new Error('Agent loop node is missing.');
    agentNode.config = { ...agentNode.config, maxIterations: 1 };
    agent.model = {
      routing: { strategy: 'ensemble', maxAttempts: 2 },
      routes: [
        { provider: 'openai', model: 'gpt-5' },
        { provider: 'gemini', model: 'gemini-2.5-flash' },
      ],
    };
    const openai = { provider: 'openai', chat: async () => ({ content: 'primary perspective', model: 'gpt-5', promptTokens: 2, completionTokens: 3 }) };
    const gemini = { provider: 'gemini', chat: async () => ({ content: 'second perspective', model: 'gemini-2.5-flash', promptTokens: 5, completionTokens: 7 }) };
    const ensembleExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, undefined, new Map(), undefined, new Map([['openai', openai], ['gemini', gemini]]));
    const run = await ensembleExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const recorded = await events.list(run.id);
    expect(recorded.filter((event) => event.type === 'llm.route.selected')).toHaveLength(2);
    expect(recorded.filter((event) => event.type === 'llm.route.selected').map((event) => event.attributes?.['llm.route.index'])).toEqual([0, 1]);
    expect(recorded.find((event) => event.type === 'llm.completed')?.attributes).toEqual(expect.objectContaining({ 'llm.provider': 'ensemble', 'llm.route.strategy': 'ensemble', 'llm.token_count.prompt': 7, 'llm.token_count.completion': 10 }));
    const output = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.unitOutputs.agent as { output?: string } | undefined);
    expect(output?.output).toContain('[openai]\nprimary perspective');
    expect(output?.output).toContain('[gemini]\nsecond perspective');
  });

  it('rejects structured-output ensembles before invoking any provider', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agent === undefined || agentNode === undefined) throw new Error('Seed agent is missing.');
    agent.outputSchema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    agent.model = {
      routing: { strategy: 'ensemble', maxAttempts: 2 },
      routes: [{ provider: 'openai', model: 'gpt-5' }, { provider: 'gemini', model: 'gemini-2.5-flash' }],
    };
    agentNode.config.maxIterations = 1;
    let providerCalls = 0;
    const providers = new Map([
      ['openai', { provider: 'openai', chat: async () => { providerCalls += 1; return { content: '{}', model: 'gpt-5' }; } }],
      ['gemini', { provider: 'gemini', chat: async () => { providerCalls += 1; return { content: '{}', model: 'gemini-2.5-flash' }; } }],
    ]);
    const ensembleExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, undefined, new Map(), undefined, providers);
    const run = await ensembleExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    expect(providerCalls).toBe(0);
    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'llm.ensemble.rejected' && event.attributes?.['llm.ensemble.policy'] === 'structured-output-rejected')).toBe(true);
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.error).toContain('structured outputs');
  });

  it('resumes an agent loop from its persisted iteration checkpoint after restart', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agentNode = workflow.nodes.find((node) => node.id === 'agent');
    if (agentNode === undefined) throw new Error('Agent node is missing.');
    agentNode.config.maxIterations = 3;
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Agent definition is missing.');
    agent.model = { provider: 'openai', model: 'test-model' };
    const run = createQueuedRun(workflow);
    run.status = 'running';
    run.completedNodeIds = ['trigger', 'prepare'];
    run.activatedNodeIds = workflow.nodes.map((node) => node.id);
    run.unitOutputs = { trigger: true, prepare: 'Validated product request' };
    run.agentCheckpoints = {
      agent: { nextIteration: 2, maxIterations: 3, outputHash: 'a'.repeat(64), updatedAt: new Date().toISOString() },
    };
    await store.mutate((state) => { state.runs.push(run); });
    const outputs: string[] = [];
    const restarted = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, {
      chat: async () => {
        outputs.push('called');
        return { content: `resumed-${outputs.length}`, model: 'test-model' };
      },
    });
    expect(await restarted.recover()).toBe(1);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.status)) === 'succeeded');
    expect(outputs).toHaveLength(2);
    expect((await events.list(run.id)).filter((event) => event.type === 'agent.iteration').map((event) => event.attributes?.['agent.iteration'])).toEqual([2, 3]);
    expect(await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.agentCheckpoints)).toEqual({});
  });

  it('pins workflow and agent versions in a deterministic release bundle hash', () => {
    const workflow = structuredClone(seedWorkflow);
    const run = createQueuedRun(workflow);
    expect(run.releaseBundleHash).toBe(releaseBundleHash(workflow));
    expect(run.pinnedAgentVersions).toEqual(Object.fromEntries(workflow.agents.map((agent) => [agent.id, agent.version])));
    const changedAgent = structuredClone(workflow);
    const agent = changedAgent.agents[0];
    if (agent === undefined) throw new Error('Agent definition is missing.');
    agent.version += 1;
    expect(releaseBundleHash(changedAgent)).not.toBe(run.releaseBundleHash);
  });

  it('fails closed when a route requires capabilities its provider does not expose', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { routes: [{ provider: 'ollama', model: 'llama3.2', capabilities: ['tools'], adapterVersion: 'ollama-v1' }] };
    const ollama = { ensureModel: async () => undefined, chat: async () => ({ content: 'unexpected', model: 'llama3.2' }) };
    const routedExecutor = new LocalWorkflowExecutor(store, events, ollama);
    const run = await routedExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.error).toMatch(/required capabilities: tools/i);
  });

  it('gates tool-capable agents on the declared before-tools approval policy', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    agent.tools = ['repo.check'];
    agent.approval = { beforeSideEffects: false, beforeTools: ['repo.check'] };
    let calls = 0;
    const openai = { chat: async () => {
      calls += 1;
      return { content: 'approved result', model: 'gpt-5' };
    } };
    const gatedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai);
    const run = await gatedExecutor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'waiting',
    );
    expect(calls).toBe(0);
    await gatedExecutor.approve(run.id);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );
    expect(calls).toBeGreaterThan(0);
  });

  it('executes only declared and registered agent tools with correlated lifecycle evidence', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agent === undefined || agentNode === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    agent.tools = ['repo.check'];
    agentNode.config.maxIterations = 1;
    const openai = { chat: async () => ({ content: '', model: 'gpt-5', toolCalls: [{ callId: 'call-1', name: 'repo.check', arguments: '{"command":"npm test"}' }] }) };
    const toolExecutors = new Map([['repo.check', async (context: { arguments: unknown; signal: AbortSignal }) => {
      context.signal.throwIfAborted();
      return { passed: true };
    }]]);
    const toolExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai, toolExecutors);
    const run = await toolExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'agent.tool.requested')).toBe(true);
    expect(recorded.some((event) => event.type === 'agent.tool.completed')).toBe(true);
    expect((await events.listEvidence(run.id)).filter((evidence) => evidence.operation === 'agent.tool' && evidence.status === 'succeeded')).toHaveLength(1);
  });

  it('does not repeat a tool side effect when a provider replays the same call ID', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agent === undefined || agentNode === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    agent.tools = ['repo.check'];
    agentNode.config.maxIterations = 2;
    let toolCalls = 0;
    const openai = { chat: async () => ({ content: '', model: 'gpt-5', toolCalls: [{ callId: 'stable-call', name: 'repo.check', arguments: '{"command":"npm test"}' }] }) };
    const toolExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai, new Map([
      ['repo.check', async () => { toolCalls += 1; return { passed: true }; }],
    ]));
    const run = await toolExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded');
    expect(toolCalls).toBe(1);
    expect((await events.listEvidence(run.id)).filter((evidence) => evidence.operation === 'agent.tool' && evidence.status === 'succeeded')).toHaveLength(1);
    expect((await events.list(run.id)).some((event) => event.type === 'agent.tool.recovered')).toBe(true);
  });

  it('emits an operator-visible event and fails closed on an incomplete tool checkpoint', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agent === undefined || agentNode === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    agent.tools = ['repo.check'];
    agentNode.config.maxIterations = 1;
    let providerCalled = false;
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const openai = {
      chat: async () => {
        providerCalled = true;
        await providerReleased;
        return { content: '', model: 'gpt-5', toolCalls: [{ callId: 'incomplete-call', name: 'repo.check', arguments: '{}' }] };
      },
    };
    let toolExecutions = 0;
    const toolExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai, new Map([
      ['repo.check', async () => { toolExecutions += 1; return { passed: true }; }],
    ]));
    const run = await toolExecutor.start(workflow);
    await waitFor(async () => providerCalled);
    await events.recordEvidence({ runId: run.id, unitId: agentNode.id, operation: 'agent.tool', idempotencyKey: 'incomplete-call:started', status: 'started', input: { name: 'repo.check', callId: 'incomplete-call' } });
    releaseProvider();
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    expect(toolExecutions).toBe(0);
    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'agent.tool.incomplete' && event.severityText === 'ERROR')).toBe(true);
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.error).toContain('incomplete checkpoint');
  });

  it('fails closed when an agent requests an undeclared tool', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agent === undefined || agentNode === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    agentNode.config.maxIterations = 1;
    const openai = { chat: async () => ({ content: '', model: 'gpt-5', toolCalls: [{ callId: 'call-1', name: 'repo.write', arguments: '{}' }] }) };
    const toolExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai, new Map());
    const run = await toolExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'agent.tool.rejected')).toBe(true);
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.error).toContain('undeclared tool');
  });

  it('enforces agent connection boundaries before invoking a provider', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    const agentNode = workflow.nodes.find((node) => node.type === 'agentLoop');
    if (agent === undefined || agentNode === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    agent.boundaries.allowedConnections = ['gemini'];
    agentNode.config.maxIterations = 1;
    let providerCalls = 0;
    const openai = { chat: async () => { providerCalls += 1; return { content: 'should not run', model: 'gpt-5' }; } };
    const connectionExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai);
    const run = await connectionExecutor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'failed');
    expect(providerCalls).toBe(0);
    const recorded = await events.list(run.id);
    expect(recorded.some((event) => event.type === 'agent.connection.denied' && event.attributes?.['connection.provider'] === 'openai')).toBe(true);
    expect((await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.error).toContain('not authorized');
  });

  it('does not execute nodes unreachable from the declared trigger', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.nodes.push({
      id: 'isolated-notification',
      type: 'notification',
      label: 'Must not execute',
      position: { x: 0, y: 0 },
      config: { message: 'unreachable' },
      unit: defaultWorkUnit('notification'),
    });

    const run = await executor.start(workflow);
    await waitFor(async () => {
      const current = await store.read((state) =>
        state.runs.find((candidate) => candidate.id === run.id),
      );
      return current?.status === 'succeeded';
    });

    const completed = await store.read((state) =>
      state.runs.find((candidate) => candidate.id === run.id),
    );
    expect(completed?.completedNodeIds).not.toContain('isolated-notification');
  });

  it('aborts active work and preserves cancellation as terminal', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.nodes.find((node) => node.id === 'agent');
    if (agent === undefined) {
      throw new Error('Seed agent node is missing.');
    }
    agent.type = 'wait';
    agent.label = 'Long wait';
    agent.config = { durationMs: 1_000 };
    agent.unit = defaultWorkUnit('wait');

    const run = await executor.start(workflow);
    await waitFor(async () =>
      (await events.list(run.id)).some(
        (event) => event.type === 'node.started' && event.nodeId === 'agent',
      ),
    );
    await executor.cancel(run.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cancelled = await store.read((state) =>
      state.runs.find((candidate) => candidate.id === run.id),
    );
    const recorded = await events.list(run.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.completedNodeIds).not.toContain('agent');
    expect(recorded.some((event) => event.type === 'run.succeeded')).toBe(false);
    expect(recorded.some((event) => event.type === 'run.failed')).toBe(false);
  });

  it('records a WorkUnit timeout as a distinct terminal run state', async () => {
    const workflow = structuredClone(seedWorkflow);
    const prepare = workflow.nodes.find((node) => node.id === 'prepare');
    if (prepare === undefined) throw new Error('Seed prepare node is missing.');
    prepare.type = 'wait';
    prepare.config = { durationMs: 1_000 };
    prepare.unit = { ...defaultWorkUnit('wait'), timeoutMs: 10 };
    const run = await executor.start(workflow);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'timed_out');
    expect((await events.list(run.id)).some((event) => event.type === 'run.timed_out')).toBe(true);
    expect((await events.listEvidence(run.id)).some((evidence) => evidence.status === 'timed_out')).toBe(true);
  });

  it('recovers persisted queued and running executions', async () => {
    const runId = 'recoverable-run';
    await store.mutate((state) => {
      state.runs.push({
        id: runId,
        workflowId: seedWorkflow.id,
        workflowName: seedWorkflow.name,
        workflowVersion: seedWorkflow.version,
        traceId: '0123456789abcdef0123456789abcdef',
        status: 'running',
        startedAt: new Date().toISOString(),
        costUsd: 0,
        humanTouchpoints: 0,
        workflowDefinition: structuredClone(seedWorkflow),
    completedNodeIds: [],
    activatedNodeIds: ['trigger'],
    approvedNodeIds: [],
    approvedNodeHashes: {},
    pendingApprovalHashes: {},
    unitOutputs: {},
    ciCheckpoints: {},
      });
    });

    expect(await executor.recover()).toBe(1);
    await waitFor(async () => {
      const current = await store.read((state) =>
        state.runs.find((candidate) => candidate.id === runId),
      );
      return current?.status === 'succeeded';
    });

    expect(
      (await events.list(runId)).some((event) => event.type === 'run.recovered'),
    ).toBe(true);
  });

  it('persists a CI checkpoint and resumes the observer after runtime restart', async () => {
    const workflow = structuredClone(seedWorkflow);
    workflow.agents = [];
    workflow.nodes = [
      { id: 'trigger', type: 'manualTrigger', label: 'Start', position: { x: 0, y: 0 }, config: {}, unit: defaultWorkUnit('manualTrigger') },
      { id: 'ci', type: 'repositoryCi', label: 'Observe CI', position: { x: 180, y: 0 }, config: { ref: 'commit-1', required: ['test'], timeoutMs: 1_000, intervalMs: 10 }, unit: defaultWorkUnit('repositoryCi') },
      { id: 'output', type: 'output', label: 'Complete', position: { x: 360, y: 0 }, config: { value: 'done' }, unit: defaultWorkUnit('output') },
    ];
    workflow.edges = [
      { id: 'trigger-ci', source: 'trigger', target: 'ci' },
      { id: 'ci-output', source: 'ci', target: 'output' },
    ];
    const firstGithub = {
      waitForChecks: vi.fn(() => new Promise<never>(() => undefined)),
    } as unknown as GitHubRepositoryClient;
    const firstExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, firstGithub);
    const run = await firstExecutor.start(workflow);
    await waitFor(async () => {
      const checkpointed = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.ciCheckpoints.ci);
      const waitingEvidence = (await events.listEvidence(run.id)).some((entry) => entry.unitId === 'ci' && entry.status === 'waiting');
      return checkpointed !== undefined && waitingEvidence;
    });
    expect((await events.listEvidence(run.id)).some((entry) => entry.unitId === 'ci' && entry.status === 'waiting')).toBe(true);

    const secondGithub = {
      waitForChecks: vi.fn().mockResolvedValue({ ref: 'commit-1', status: 'success', checks: [{ name: 'test', status: 'completed', conclusion: 'success' }], required: ['test'], failures: [] }),
    } as unknown as GitHubRepositoryClient;
    const restartedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, secondGithub);
    expect(await restartedExecutor.recover()).toBe(1);
    await waitFor(async () => (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.status)) === 'succeeded');
    expect(secondGithub.waitForChecks).toHaveBeenCalledWith(expect.objectContaining({ ref: 'commit-1', timeoutMs: expect.any(Number) }));
    expect(await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.ciCheckpoints)).toEqual({});
    expect((await events.listEvidence(run.id)).filter((entry) => entry.unitId === 'ci' && entry.status === 'waiting')).toHaveLength(1);
  });
});
