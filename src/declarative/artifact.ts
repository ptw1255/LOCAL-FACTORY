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
