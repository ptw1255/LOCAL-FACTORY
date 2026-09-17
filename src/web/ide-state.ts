import type {
  ArtifactRecord,
  RunEvent,
  RunRecord,
  SourceDiagnostic,
  WorkflowDefinition,
  WorkflowNode,
} from './types';

export type ObserveTab = 'runs' | 'logs' | 'traces' | 'metrics';
export type BottomPanelTab = 'problems' | 'output';

export function observeRunHash(runId: string | null): string {
  return observeScopeHash(runId);
}

/** Build a canonical, shareable Observe URL including optional scope filters. */
export function observeScopeHash(runId: string | null, workflowId?: string, environment?: string): string {
  const params = new URLSearchParams();
  if (runId !== null && runId.trim() !== '') params.set('runId', runId.trim());
  if (workflowId !== undefined && workflowId.trim() !== '' && workflowId !== 'all') params.set('workflowId', workflowId.trim());
  if (environment !== undefined && environment.trim() !== '' && environment !== 'all') params.set('environment', environment.trim());
  const query = params.toString();
  return query === '' ? '#/observe' : '#/observe?' + query;
}

export function renameOpenPath(paths: string[], previousPath: string, nextPath: string): string[] {
  return paths.map((path) => path === previousPath ? nextPath : path);
}

export function removeOpenPath(paths: string[], removedPath: string, fallbackPath: string): string[] {
  const remaining = paths.filter((path) => path !== removedPath);
  return remaining.length === 0 ? [fallbackPath] : remaining;
}

export function nextExplorerIndex(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  if (direction === 1 && index >= count - 1) return 0;
  if (direction === -1 && index <= 0) return count - 1;
  return index + direction;
}

export function filterProjectItems<T extends { projectId?: string }>(items: T[], projectId: string): T[] {
  return items.filter((item) => item.projectId === projectId);
}

export function retainSelection<T extends { id: string }>(items: T[], selectedId: string | null): string | null {
  return selectedId !== null && items.some((item) => item.id === selectedId) ? selectedId : items[0]?.id ?? null;
}

/**
 * Merge the just-created run into the polled project history without
 * duplicating it when the API response catches up.
 */
export function mergeRecentRuns(runs: RunRecord[], started: RunRecord | null, projectId: string, limit = 5): RunRecord[] {
  // Prefer the server-polled record when the same ID is present so queued
  // feedback naturally advances to running/completed status.
  const candidates = started !== null && started.projectId === projectId ? [...runs, started] : runs;
  const unique = new Map<string, RunRecord>();
  for (const run of candidates) {
    if (run.projectId !== projectId || unique.has(run.id)) continue;
    unique.set(run.id, run);
  }
  return [...unique.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, Math.max(1, limit));
}

/** Atomically gate command/button paths so one workflow run starts at a time. */
export function tryAcquireRunLock(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function selectWorkflowArtifact(artifacts: ArtifactRecord[], workflowId: string, environment: string, preferred?: ArtifactRecord | null): ArtifactRecord | undefined {
  const candidates = preferred === undefined || preferred === null
    ? artifacts
    : [preferred, ...artifacts.filter((artifact) => artifact.id !== preferred.id)];
  return candidates
    .filter((artifact) => artifact.environment === environment && artifact.workflows.some((workflow) => workflow.id === workflowId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function nextObserveTab(tab: ObserveTab, key: string): ObserveTab | null {
  const tabs: ObserveTab[] = ['runs', 'logs', 'traces', 'metrics'];
  const index = tabs.indexOf(tab);
  const nextIndex = key === 'ArrowRight' || key === 'ArrowDown'
    ? (index + 1) % tabs.length
    : key === 'ArrowLeft' || key === 'ArrowUp'
      ? (index - 1 + tabs.length) % tabs.length
      : key === 'Home'
        ? 0
        : key === 'End'
          ? tabs.length - 1
          : -1;
  return nextIndex < 0 ? null : tabs[nextIndex]!;
}

/** Roving keyboard navigation for the Workspace bottom panel tabs. */
export function nextBottomPanelTab(tab: BottomPanelTab, key: string): BottomPanelTab | null {
  const tabs: BottomPanelTab[] = ['problems', 'output'];
  const index = tabs.indexOf(tab);
  if (index < 0) return null;
  const nextIndex = key === 'ArrowRight'
    ? (index + 1) % tabs.length
    : key === 'ArrowLeft'
      ? (index - 1 + tabs.length) % tabs.length
      : key === 'Home'
        ? 0
        : key === 'End'
          ? tabs.length - 1
          : -1;
  return nextIndex < 0 ? null : tabs[nextIndex]!;
}

/** Return the next focus target for a modal dialog's Tab sequence. */
export function nextDialogFocusIndex(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return direction === 1 ? 0 : count - 1;
  return (index + direction + count) % count;
}

export function projectSwitchRequiresConfirmation(currentProjectId: string | null, nextProjectId: string, dirty: boolean): boolean {
  return currentProjectId !== null && currentProjectId !== nextProjectId && dirty;
}

function sourceLineColumn(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function sourceSyntaxDiagnostics(source: string, path: string, parseErrors: Array<{ message?: string; pos?: [number, number] }>): SourceDiagnostic[] {
  return parseErrors.map((parseError) => {
    const { line, column } = sourceLineColumn(source, parseError.pos?.[0] ?? 0);
    const message = (parseError.message ?? 'Invalid YAML or JSON syntax.').split(/\r?\n/, 1)[0] ?? 'Invalid YAML or JSON syntax.';
    return { severity: 'error', path, line, column, code: 'yaml.parse', message };
  });
}

export function sourceNodeForLine(workflow: WorkflowDefinition, path: string, line: number): WorkflowNode | undefined {
  const defaultPath = 'workflows/' + workflow.id + '.workflow.yaml';
  const candidates = workflow.nodes
    .filter((node) => (node.sourcePath ?? defaultPath) === path && node.sourceLine !== undefined && node.sourceLine <= line)
    .sort((left, right) => (right.sourceLine ?? 0) - (left.sourceLine ?? 0));
  return candidates[0];
}

export function clampBottomPanelHeight(value: number): number {
  return Math.min(640, Math.max(120, Math.round(value)));
}

/** Keep deployment log expansion bounded and payload-free at the UI boundary. */
export function recentRunLogs(events: RunEvent[], limit = 40): RunEvent[] {
  return events
    .filter((event) => event.signal === 'log')
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-Math.max(1, limit));
}
