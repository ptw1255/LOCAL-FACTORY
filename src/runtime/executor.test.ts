import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { defaultWorkUnit } from '../domain/catalog.js';
import { EventService } from '../observability/event-service.js';
import { JsonStore } from '../storage/json-store.js';
import { LocalWorkflowExecutor } from './executor.js';

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
    const approval = await store.read((state) => state.approvals.find((candidate) => candidate.runId === run.id && candidate.nodeId === 'approval'));
    expect(approval).toEqual(expect.objectContaining({ decision: 'approved', bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
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

  it('routes OpenAI agents through the provider-neutral agent lifecycle', async () => {
    const workflow = structuredClone(seedWorkflow);
    const agent = workflow.agents[0];
    if (agent === undefined) throw new Error('Seed agent is missing.');
    agent.model = { provider: 'openai', model: 'gpt-5' };
    const openai = { chat: async () => ({ content: 'hosted result', model: 'gpt-5', promptTokens: 3, completionTokens: 2, requestId: 'req-1' }) };
    const hostedExecutor = new LocalWorkflowExecutor(store, events, undefined, undefined, undefined, undefined, openai);
    const run = await hostedExecutor.start(workflow);
    await waitFor(async () =>
      (await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)))?.status === 'succeeded',
    );
    const recorded = await events.list(run.id);
    expect(recorded.find((event) => event.type === 'llm.completed')?.attributes).toEqual(expect.objectContaining({ 'llm.provider': 'openai', 'llm.request_id': 'req-1' }));
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
});
