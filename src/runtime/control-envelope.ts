import { createHash } from 'node:crypto';

import type { AgentDefinition, WorkflowNode } from '../domain/types.js';

export interface AgentControlEnvelope {
  version: 1;
  runId: string;
  unitId: string;
  agentId: string;
  agentVersion: number;
  contextHash: string;
  allowedTools: string[];
  allowedConnections: string[];
  protectedPaths: string[];
  evidence: { mode: 'metadata-only'; required: string[] };
}

function text(value: unknown, label: string, max = 300): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

/** Create a provider-neutral control boundary for any agent adapter (including Jev). */
export function createAgentControlEnvelope(input: {
  runId: string;
  node: WorkflowNode;
  agent: AgentDefinition;
  context: unknown;
}): AgentControlEnvelope {
  const contextHash = createHash('sha256').update(JSON.stringify(input.context) ?? 'undefined').digest('hex');
  return {
    version: 1,
    runId: text(input.runId, 'runId'),
    unitId: text(input.node.id, 'unitId'),
    agentId: text(input.agent.id, 'agentId'),
    agentVersion: input.agent.version,
    contextHash,
    allowedTools: [...new Set(input.agent.tools)].sort(),
    allowedConnections: [...new Set(input.agent.boundaries.allowedConnections)].sort(),
    protectedPaths: [...new Set(input.agent.boundaries.protectedPaths)].sort(),
    evidence: { mode: 'metadata-only', required: ['agent.iteration', 'agent.checkpoint.saved'] },
  };
}

export function validateAgentControlEnvelope(value: unknown): AgentControlEnvelope {
  if (value === null || typeof value !== 'object') throw new Error('AgentControlEnvelope must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error('AgentControlEnvelope.version must be 1.');
  if (typeof candidate.runId !== 'string' || typeof candidate.unitId !== 'string' || typeof candidate.agentId !== 'string' || typeof candidate.agentVersion !== 'number' || !Number.isSafeInteger(candidate.agentVersion) || candidate.agentVersion < 1 || typeof candidate.contextHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.contextHash)) throw new Error('AgentControlEnvelope identity is invalid.');
  const list = (name: string): string[] => {
    const value = candidate[name];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`AgentControlEnvelope.${name} must be a string array.`);
    return [...new Set(value as string[])].sort();
  };
  if (candidate.evidence === null || typeof candidate.evidence !== 'object') throw new Error('AgentControlEnvelope.evidence is required.');
  const evidence = candidate.evidence as Record<string, unknown>;
  if (evidence.mode !== 'metadata-only' || !Array.isArray(evidence.required) || evidence.required.some((item) => typeof item !== 'string')) throw new Error('AgentControlEnvelope evidence policy is invalid.');
  return {
    version: 1,
    runId: text(candidate.runId, 'runId'),
    unitId: text(candidate.unitId, 'unitId'),
    agentId: text(candidate.agentId, 'agentId'),
    agentVersion: candidate.agentVersion as number,
    contextHash: candidate.contextHash,
    allowedTools: list('allowedTools'),
    allowedConnections: list('allowedConnections'),
    protectedPaths: list('protectedPaths'),
    evidence: { mode: 'metadata-only', required: [...new Set(evidence.required as string[])].sort() },
  };
}

export function agentControlEnvelopeHash(envelope: AgentControlEnvelope): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}
