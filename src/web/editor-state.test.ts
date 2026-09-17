import { describe, expect, it } from 'vitest';

import { removeOpenPath, renameOpenPath } from './App';

describe('IDE editor tab state', () => {
  it('renames an open path without disturbing tab order', () => {
    expect(renameOpenPath(['project.yaml', 'workflows/review.yaml', 'agents/reviewer.agent.yaml'], 'workflows/review.yaml', 'workflows/approval.yaml'))
      .toEqual(['project.yaml', 'workflows/approval.yaml', 'agents/reviewer.agent.yaml']);
  });

  it('removes a deleted path and keeps a usable fallback tab', () => {
    expect(removeOpenPath(['project.yaml', 'workflows/review.yaml'], 'workflows/review.yaml', 'project.yaml'))
      .toEqual(['project.yaml']);
    expect(removeOpenPath(['workflows/review.yaml'], 'workflows/review.yaml', 'project.yaml'))
      .toEqual(['project.yaml']);
  });
});
