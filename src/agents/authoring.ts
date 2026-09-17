import { compileResourceFiles, mergeProjectResourcePaths } from '../declarative/resources.js';
import { planResourceMigration } from '../declarative/migration.js';
import type { AuthoringFileChange, ProjectFileRecord, ProjectRecord, SourceDiagnostic, WorkflowDefinition } from '../domain/types.js';

function sourceDiagnostics(error: unknown): SourceDiagnostic[] {
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  if (Array.isArray(diagnostics)) return diagnostics as SourceDiagnostic[];
  return [{
    severity: 'error',
    path: 'factory.yaml',
    line: 1,
    column: 1,
    code: 'authoring.invalid',
    message: error instanceof Error ? error.message : 'Authoring proposal is invalid.',
  }];
}

function resourceLabel(path: string, content: string): string {
  const kind = /^kind:\s*([^\n#]+)/m.exec(content)?.[1]?.trim();
  const id = /^\s+id:\s*([^\n#]+)/m.exec(content)?.[1]?.trim();
  return kind === undefined ? path : `${kind}${id === undefined ? '' : `/${id}`}`;
}

export function createAuthoringChanges(
  currentFiles: readonly ProjectFileRecord[],
  proposed: readonly { path: string; content: string }[],
): AuthoringFileChange[] {
  const current = new Map(currentFiles.map((file) => [file.path, file]));
  return proposed.flatMap((file) => {
    const existing = current.get(file.path);
    if (existing?.content === file.content) return [];
    const operation = existing === undefined ? 'create' as const : 'update' as const;
    return [{
      path: file.path,
      operation,
      content: file.content,
      ...(existing === undefined ? {} : { baseSha256: existing.sha256 }),
      summary: `${operation === 'create' ? 'Create' : 'Update'} ${resourceLabel(file.path, file.content)}`,
    }];
  });
}

/** Convert an AI-planned WorkflowDefinition into the same resource envelopes
 * used by human-authored projects while retaining every existing Project ref. */
export function planWorkflowAuthoringChanges(
  project: ProjectRecord,
  workflow: WorkflowDefinition,
  currentFiles: readonly ProjectFileRecord[],
): AuthoringFileChange[] {
  const plan = planResourceMigration(project, [workflow]);
  const generated = plan.files.filter((file) => file.path !== 'factory.yaml');
  const currentFactory = currentFiles.find((file) => file.path === 'factory.yaml' || file.path === 'factory.yml');
  const plannedFactory = plan.files.find((file) => file.path === 'factory.yaml');
  if (plannedFactory === undefined) throw new Error('Workflow authoring did not produce a Project envelope.');
  const factory = currentFactory === undefined
    ? plannedFactory
    : { path: currentFactory.path, source: mergeProjectResourcePaths(currentFactory.content, generated.map((file) => file.path)) };
  return createAuthoringChanges(currentFiles, [factory, ...generated].map((file) => ({ path: file.path, content: file.source })));
}

export function validateAuthoringChanges(
  currentFiles: readonly ProjectFileRecord[],
  changes: readonly AuthoringFileChange[],
  scope: { tenantId: string; projectId: string; environment?: string },
): { valid: boolean; issues: SourceDiagnostic[] } {
  const current = new Map(currentFiles.map((file) => [file.path, file]));
  const conflicts: SourceDiagnostic[] = changes.flatMap((change) => {
    const existing = current.get(change.path);
    const conflict = change.operation === 'create' ? existing !== undefined : existing?.sha256 !== change.baseSha256;
    return conflict ? [{ severity: 'error' as const, path: change.path, line: 1, column: 1, code: 'authoring.conflict', message: 'Project source changed after this proposal was created.' }] : [];
  });
  if (conflicts.length > 0) return { valid: false, issues: conflicts };
  const merged = new Map(currentFiles.map((file) => [file.path, file.content]));
  for (const change of changes) merged.set(change.path, change.content);
  try {
    compileResourceFiles(
      [...merged].map(([path, source]) => ({ path, source })),
      { tenantId: scope.tenantId, projectId: scope.projectId, environment: scope.environment ?? 'local' },
    );
    return { valid: true, issues: [] };
  } catch (error) {
    return { valid: false, issues: sourceDiagnostics(error) };
  }
}

export function authoringSemanticDiff(changes: readonly AuthoringFileChange[]): string[] {
  return changes.map((change) => `${change.operation.toUpperCase()} ${change.path} — ${change.summary}`);
}
