import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { JsonStore } from '../storage/json-store.js';
import { ProposalService } from './proposal-service.js';

describe('ProposalService', () => {
  it('creates a valid bounded proposal from a goal', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-agent-'));
    const store = new JsonStore(path.join(directory, 'state.json'));
    const service = new ProposalService(store);

    const proposal = await service.create(
      seedWorkflow,
      'Receive a webhook, analyze the request with an agent, request human approval, and notify operations.',
    );

    expect(proposal.workflow.nodes.map((node) => node.type)).toEqual([
      'webhookTrigger',
      'approval',
      'agentLoop',
      'notification',
      'output',
    ]);
    expect(proposal.issues.filter((issue) => issue.level === 'error')).toHaveLength(0);
  });

  it('turns a structured authoring brief into an ordered workflow blueprint', () => {
    const service = new ProposalService({} as never);
    const proposal = service.plan({ ...seedWorkflow, agents: [] }, 'Review incoming changes and publish a decision.', {
      objective: 'Review incoming changes and publish a decision.',
      trigger: 'webhook',
      input: 'Repository and patch metadata',
      preparation: 'Validate and normalize repository context',
      agentTask: 'Assess the patch for correctness and risk',
      externalAction: 'Notify the pull request owner',
      approval: 'before-side-effects',
      output: 'Return a structured review decision',
      constraints: 'Use declared read-only tools',
    });

    expect(proposal.workflow.nodes.map((node) => node.type)).toEqual([
      'webhookTrigger',
      'transform',
      'agentLoop',
      'approval',
      'notification',
      'output',
    ]);
    expect(proposal.workflow.nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      'Validate and normalize repository context',
      'Assess the patch for correctness and risk',
      'Approve side effect',
    ]));
    expect(proposal.workflow.nodes.find((node) => node.type === 'agentLoop')?.config.goal).toBe('Assess the patch for correctness and risk');
    expect(proposal.workflow.agents[0]).toEqual(expect.objectContaining({ id: `${seedWorkflow.id}-agent`, purpose: 'Assess the patch for correctness and risk' }));
    expect(proposal.workflow.nodes.find((node) => node.type === 'agentLoop')?.config.agentId).toBe(`${seedWorkflow.id}-agent`);
    expect(proposal.workflow.inputSchema).toEqual({ type: 'object', description: 'Repository and patch metadata' });
  });
});
