import { describe, expect, it } from 'vitest';

import type { AgentDefinition, WorkflowNode } from '../domain/types.js';
import { agentControlEnvelopeHash, createAgentControlEnvelope, validateAgentControlEnvelope } from './control-envelope.js';

const agent = {
  id: 'jev-operator', version: 1, name: 'Operator', purpose: 'Control', instructions: 'Control safely.', skills: [], tools: ['repo.check', 'repo.check'],
  model: { provider: 'jev', model: 'jev-control' }, inputSchema: {}, outputSchema: {},
  boundaries: { allowedConnections: ['typesafe-ai', 'typesafe-ai'], allowedRepositories: ['example/repo'], protectedPaths: ['.env'], network: 'allow-listed', dataClasses: [] },
  limits: { maxIterations: 1, maxCostUsd: 1, maxDurationMs: 1_000, maxTokens: 32 }, termination: { successConditions: ['done'], failureConditions: [], escalationConditions: [] },
  approval: { beforeSideEffects: false, beforeTools: [] }, observability: { captureInputs: false, captureOutputs: false, redactedFields: [] },
} satisfies AgentDefinition;

const node: WorkflowNode = { id: 'control', type: 'agentLoop', label: 'Control', position: { x: 0, y: 0 }, config: {} };

describe('AgentControlEnvelope', () => {
  it('normalizes boundaries and hashes a metadata-only control contract', () => {
    const envelope = createAgentControlEnvelope({ runId: 'run-1', node, agent, context: { revision: 'abc' } });
    expect(envelope.allowedTools).toEqual(['repo.check']);
    expect(envelope.allowedConnections).toEqual(['typesafe-ai']);
    expect(envelope.evidence.mode).toBe('metadata-only');
    expect(agentControlEnvelopeHash(validateAgentControlEnvelope(envelope))).toHaveLength(64);
  });

  it('rejects malformed or content-capturing control contracts', () => {
    const envelope = createAgentControlEnvelope({ runId: 'run-1', node, agent, context: {} });
    expect(() => validateAgentControlEnvelope({ ...envelope, contextHash: 'bad' })).toThrow(/identity/);
    expect(() => validateAgentControlEnvelope({ ...envelope, evidence: { mode: 'full', required: [] } })).toThrow(/evidence policy/);
  });
});
