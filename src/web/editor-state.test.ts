import { describe, expect, it } from 'vitest';

import { filterProjectItems, nextExplorerIndex, projectSwitchRequiresConfirmation, removeOpenPath, renameOpenPath } from './App';

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

  it('wraps keyboard explorer focus at either end of the visible list', () => {
    expect(nextExplorerIndex(0, -1, 3)).toBe(2);
    expect(nextExplorerIndex(2, 1, 3)).toBe(0);
    expect(nextExplorerIndex(1, 1, 3)).toBe(2);
  });

  it('only prompts when switching away from a dirty project', () => {
    expect(projectSwitchRequiresConfirmation('project-a', 'project-b', true)).toBe(true);
    expect(projectSwitchRequiresConfirmation('project-a', 'project-a', true)).toBe(false);
    expect(projectSwitchRequiresConfirmation(null, 'project-b', true)).toBe(false);
    expect(projectSwitchRequiresConfirmation('project-a', 'project-b', false)).toBe(false);
  });

  it('keeps project-scoped operational items isolated', () => {
    const items = [{ id: 'run-a', projectId: 'project-a' }, { id: 'run-b', projectId: 'project-b' }];
    expect(filterProjectItems(items, 'project-a')).toEqual([{ id: 'run-a', projectId: 'project-a' }]);
  });
});
