import { describe, expect, it } from 'vitest';

import { computeArtifactId, diffArtifacts } from './artifact.js';
import { seedWorkflow } from '../domain/seed.js';

describe('artifact identity', () => {
  it('is stable across compiler runtime timestamps and source ordering', () => {
    const first = structuredClone(seedWorkflow);
    first.createdAt = '2026-01-01T00:00:00.000Z';
    first.updatedAt = '2026-01-01T00:00:00.000Z';
    const second = structuredClone(first);
    second.createdAt = '2026-02-01T00:00:00.000Z';
    second.updatedAt = '2026-02-01T00:00:00.000Z';
    const input = { environment: 'local', compilerVersion: '0.1.0', sources: [{ path: 'b.yaml', sha256: 'b' }, { path: 'a.yaml', sha256: 'a' }] };
    expect(computeArtifactId({ ...input, workflows: [first] })).toBe(computeArtifactId({ ...input, sources: [...input.sources].reverse(), workflows: [second] }));
  });

  it('changes when an environment, compiler, or source digest changes', () => {
    const base = { environment: 'local', compilerVersion: '0.1.0', sources: [{ path: 'factory.yaml', sha256: 'a' }], workflows: [structuredClone(seedWorkflow)] };
    expect(computeArtifactId(base)).not.toBe(computeArtifactId({ ...base, environment: 'production' }));
    expect(computeArtifactId(base)).not.toBe(computeArtifactId({ ...base, compilerVersion: '0.2.0' }));
    expect(computeArtifactId(base)).not.toBe(computeArtifactId({ ...base, sources: [{ path: 'factory.yaml', sha256: 'b' }] }));
  });

  it('reports changed sources and workflow additions/removals', () => {
    const from = { id: 'sha256:from', environment: 'local', compilerVersion: '0.1.0', sources: [{ path: 'factory.yaml', sha256: 'a' }, { path: 'old.yaml', sha256: 'old' }], workflows: [structuredClone(seedWorkflow)] };
    const changed = structuredClone(seedWorkflow);
    changed.name = 'Changed';
    const to = { id: 'sha256:to', environment: 'local', compilerVersion: '0.1.0', sources: [{ path: 'factory.yaml', sha256: 'b' }, { path: 'new.yaml', sha256: 'new' }], workflows: [changed, { ...structuredClone(seedWorkflow), id: 'added' }] };
    expect(diffArtifacts(from, to)).toEqual({
      fromArtifactId: 'sha256:from',
      toArtifactId: 'sha256:to',
      changedSources: [
        { path: 'factory.yaml', fromSha256: 'a', toSha256: 'b' },
        { path: 'new.yaml', toSha256: 'new' },
        { path: 'old.yaml', fromSha256: 'old' },
      ],
      addedWorkflows: ['added'],
      removedWorkflows: [],
      changedWorkflows: [seedWorkflow.id],
    });
  });
});
