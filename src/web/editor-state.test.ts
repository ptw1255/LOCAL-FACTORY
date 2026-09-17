import { describe, expect, it } from 'vitest';

import { clampBottomPanelHeight, filterProjectItems, nextExplorerIndex, nextObserveTab, observeRunHash, projectSwitchRequiresConfirmation, removeOpenPath, renameOpenPath, retainSelection, selectWorkflowArtifact, sourceSyntaxDiagnostics } from './App';

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

  it('moves selection to the first visible run when filters hide it', () => {
    expect(retainSelection([{ id: 'run-a' }, { id: 'run-b' }], 'run-b')).toBe('run-b');
    expect(retainSelection([{ id: 'run-a' }, { id: 'run-b' }], 'run-c')).toBe('run-a');
    expect(retainSelection([], 'run-c')).toBeNull();
  });

  it('clamps persisted bottom panel heights to usable bounds', () => {
    expect(clampBottomPanelHeight(40)).toBe(120);
    expect(clampBottomPanelHeight(320.4)).toBe(320);
    expect(clampBottomPanelHeight(900)).toBe(640);
  });

  it('wraps Observe tab keyboard navigation and supports Home/End', () => {
    expect(nextObserveTab('runs', 'ArrowLeft')).toBe('metrics');
    expect(nextObserveTab('metrics', 'ArrowRight')).toBe('runs');
    expect(nextObserveTab('traces', 'Home')).toBe('runs');
    expect(nextObserveTab('runs', 'End')).toBe('metrics');
    expect(nextObserveTab('runs', 'Enter')).toBeNull();
  });

  it('maps parser errors to source-aware Problems diagnostics', () => {
    expect(sourceSyntaxDiagnostics('kind: Workflow\nspec:\n  - broken', 'workflows/review.workflow.yaml', [{ message: 'bad indentation', pos: [23, 24] }])).toEqual([{
      severity: 'error',
      path: 'workflows/review.workflow.yaml',
      line: 3,
      column: 3,
      code: 'yaml.parse',
      message: 'bad indentation',
    }]);
  });

  it('creates a shareable Observe URL for a selected run', () => {
    expect(observeRunHash('run 1')).toBe('#/observe?runId=run+1');
    expect(observeRunHash(null)).toBe('#/observe');
    expect(observeRunHash('   ')).toBe('#/observe');
  });

  it('prefers the newest compiled artifact for the selected workflow and environment', () => {
    const older = { id: 'artifact-old', environment: 'local', createdAt: '2026-01-01T00:00:00.000Z', workflows: [{ id: 'workflow-a' }] } as never;
    const newer = { id: 'artifact-new', environment: 'local', createdAt: '2026-01-02T00:00:00.000Z', workflows: [{ id: 'workflow-a' }] } as never;
    expect(selectWorkflowArtifact([older, newer], 'workflow-a', 'local')?.id).toBe('artifact-new');
    const justCompiled = { id: 'artifact-compiled', environment: 'local', createdAt: '2026-01-03T00:00:00.000Z', workflows: [{ id: 'workflow-a' }] } as never;
    expect(selectWorkflowArtifact([older, newer], 'workflow-a', 'local', justCompiled)?.id).toBe('artifact-compiled');
  });
});
