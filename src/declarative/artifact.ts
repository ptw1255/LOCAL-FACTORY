import { createHash } from 'node:crypto';

import type { ArtifactRecord, WorkflowDefinition } from '../domain/types.js';

const runtimeFields = new Set(['createdAt', 'updatedAt']);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !runtimeFields.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

export interface ArtifactDigestInput {
  environment: string;
  compilerVersion: string;
  sources: Array<{ path: string; sha256: string }>;
  workflows: WorkflowDefinition[];
}

/** Computes the stable identity of a compiled artifact. Runtime timestamps are
 * intentionally excluded; authored source, schema, compiler, and environment
 * inputs remain part of the digest. */
export function computeArtifactId(input: ArtifactDigestInput): string {
  const normalized = canonicalize({
    apiVersion: 'factory.agentic/v1',
    environment: input.environment,
    compilerVersion: input.compilerVersion,
    sources: [...input.sources].sort((left, right) => left.path.localeCompare(right.path)),
    workflows: input.workflows,
  });
  const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return `sha256:${digest}`;
}

export function artifactDigestInput(artifact: Pick<ArtifactRecord, 'environment' | 'compilerVersion' | 'sources' | 'workflows'>): ArtifactDigestInput {
  return {
    environment: artifact.environment,
    compilerVersion: artifact.compilerVersion,
    sources: artifact.sources,
    workflows: artifact.workflows,
  };
}

export interface ArtifactDiff {
  fromArtifactId: string;
  toArtifactId: string;
  changedSources: Array<{ path: string; fromSha256?: string; toSha256?: string }>;
  addedWorkflows: string[];
  removedWorkflows: string[];
  changedWorkflows: string[];
}

/** Compare two immutable artifacts without exposing runtime timestamps. */
export function diffArtifacts(from: Pick<ArtifactRecord, 'id' | 'sources' | 'workflows'>, to: Pick<ArtifactRecord, 'id' | 'sources' | 'workflows'>): ArtifactDiff {
  const fromSources = new Map(from.sources.map((source) => [source.path, source.sha256]));
  const toSources = new Map(to.sources.map((source) => [source.path, source.sha256]));
  const changedSources = [...new Set([...fromSources.keys(), ...toSources.keys()])]
    .sort()
    .filter((path) => fromSources.get(path) !== toSources.get(path))
    .map((path) => ({ path, ...(fromSources.get(path) === undefined ? {} : { fromSha256: fromSources.get(path) }), ...(toSources.get(path) === undefined ? {} : { toSha256: toSources.get(path) }) }));
  const fromWorkflows = new Map(from.workflows.map((workflow) => [workflow.id, workflow]));
  const toWorkflows = new Map(to.workflows.map((workflow) => [workflow.id, workflow]));
  const addedWorkflows = [...toWorkflows.keys()].filter((id) => !fromWorkflows.has(id)).sort();
  const removedWorkflows = [...fromWorkflows.keys()].filter((id) => !toWorkflows.has(id)).sort();
  const changedWorkflows = [...toWorkflows.keys()]
    .filter((id) => fromWorkflows.has(id) && JSON.stringify(canonicalize(fromWorkflows.get(id))) !== JSON.stringify(canonicalize(toWorkflows.get(id))))
    .sort();
  return { fromArtifactId: from.id, toArtifactId: to.id, changedSources, addedWorkflows, removedWorkflows, changedWorkflows };
}
