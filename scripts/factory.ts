import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { parseProjectYaml } from '../src/declarative/yaml.js';
import { compileResourceFiles, parseResourceFile } from '../src/declarative/resources.js';
import { EventService } from '../src/observability/event-service.js';
import { LocalWorkflowExecutor } from '../src/runtime/executor.js';
import { JsonStore } from '../src/storage/json-store.js';
import { createSeedState } from '../src/domain/seed.js';
import { addProjectResourcePaths, authoringSlug, canvasResourcePath, renderStarterCanvasFile, renderStarterWorkflowFile, renderWorkspaceProjectFile, workflowResourcePath } from './factory-authoring.js';
import { browserOpenCommand, composeArguments, isLifecycleCommand, parseFactoryArgs, usageText, type FactoryArgs } from './factory-cli.js';
import { backTerminalState, editTerminalSource, pendingApproval, portalItemCount, renderTerminalPortal, renderTerminalSnapshot, type TerminalPortalPage, type TerminalPortalState, type TerminalPrompt, type TerminalSnapshot } from './factory-terminal.js';

const dashboardUrl = (process.env.FACTORY_BASE_URL?.trim() || 'http://localhost:3100').replace(/\/$/, '');

function runExternal(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, [...args], { stdio: 'inherit', env: environment });
  if (result.error !== undefined) throw new Error(`Unable to run ${command}: ${result.error.message}. Is Docker Desktop installed and running?`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function compose(action: Parameters<typeof composeArguments>[0], args: FactoryArgs): void {
  runExternal('docker', ['compose', ...composeArguments(action, args.profiles, args.service)], { ...process.env, ...(args.web ? {} : { FACTORY_WEB: 'disabled' }) });
}

async function waitForDashboard(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${dashboardUrl}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      // The app is still starting; keep the bounded retry loop quiet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('FACTORY did not become healthy within 90 seconds. Check "factory logs app".');
}

function openDashboard(view: 'observe' | 'dag' | 'deployments' | 'studio' = 'studio'): void {
  const route = view === 'observe' ? '#/observe' : view === 'deployments' ? '#/deployments' : view === 'dag' ? '#/studio?view=canvas' : '#/studio';
  const url = `${dashboardUrl}/${route}`;
  console.log(`FACTORY dashboard: ${url}`);
  if (process.env.FACTORY_NO_OPEN === '1') return;
  const opener = browserOpenCommand(url);
  const result = spawnSync(opener.command, opener.args, { stdio: 'ignore', env: process.env });
  if (result.error !== undefined) console.warn(`Could not open a browser automatically. Open ${url} manually.`);
}

async function requestJson<T>(route: string, init?: RequestInit): Promise<T> {
  const apiToken = process.env.FACTORY_API_TOKEN?.trim();
  const tenantId = process.env.FACTORY_TENANT_ID?.trim();
  const response = await fetch(`${dashboardUrl}${route}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(apiToken === undefined || apiToken === '' ? {} : { authorization: `Bearer ${apiToken}` }),
      ...(tenantId === undefined || tenantId === '' ? {} : { 'x-tenant-id': tenantId }),
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: unknown;
  try { body = text === '' ? undefined : JSON.parse(text); } catch { body = text; }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

function projectHeaders(projectId: string | undefined): Record<string, string> {
  return projectId === undefined ? {} : { 'x-project-id': projectId };
}

function editorInvocation(filePath: string): { command: string; args: string[] } {
  const configured = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || (process.platform === 'win32' ? 'notepad' : 'vi');
  // Keep the launcher dependency-free while allowing the common `code --wait`
  // and `vim -f` forms. Quoted arguments are intentionally preserved as one
  // token; editors that need a shell pipeline should be wrapped by the user.
  const tokens = configured.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, '')) ?? [];
  const [command, ...args] = tokens;
  if (command === undefined || command === '') throw new Error('VISUAL/EDITOR is empty; set it to a terminal editor such as vi or nano.');
  return { command, args: [...args, filePath] };
}

async function editRemoteProjectFile(projectId: string, filePath: string): Promise<void> {
  const headers = projectHeaders(projectId);
  const current = await requestJson<import('../src/domain/types.js').ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(filePath)}`, { headers });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-author-'));
  const temporaryPath = path.join(directory, path.basename(filePath));
  await writeFile(temporaryPath, current.content ?? '', 'utf8');
  try {
    const editor = editorInvocation(temporaryPath);
    const result = spawnSync(editor.command, editor.args, { stdio: 'inherit', env: process.env });
    if (result.error !== undefined) throw new Error(`Unable to open ${editor.command}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${editor.command} exited with status ${String(result.status ?? 1)}.`);
    const nextSource = await readFile(temporaryPath, 'utf8');
    if (nextSource === (current.content ?? '')) {
      console.log(`FACTORY no changes: ${filePath}`);
      return;
    }
    await requestJson(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ path: filePath, content: nextSource, expectedSha256: current.sha256 }),
    });
    try {
      const artifact = await requestJson<{ id: string }>(`/api/projects/${encodeURIComponent(projectId)}/compile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ environment: process.env.FACTORY_ENVIRONMENT?.trim() || 'local' }),
      });
      console.log(`FACTORY saved ${filePath} and compiled artifact ${artifact.id}.`);
    } catch (error) {
      throw new Error(`Saved ${filePath}, but compilation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function compileRemoteProject(projectId: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(`/api/projects/${encodeURIComponent(projectId)}/compile`, {
    method: 'POST',
    headers: projectHeaders(projectId),
    body: JSON.stringify({ environment: process.env.FACTORY_ENVIRONMENT?.trim() || 'local' }),
  });
}

async function resolveRemoteProject(projectId?: string): Promise<import('../src/domain/types.js').ProjectRecord> {
  const projects = await requestJson<{ items: import('../src/domain/types.js').ProjectRecord[] }>('/api/projects');
  const requested = projectId ?? process.env.FACTORY_PROJECT_ID?.trim();
  const project = projects.items.find((candidate) => candidate.id === requested) ?? (requested === undefined || requested === '' ? projects.items[0] : undefined);
  if (project === undefined) throw new Error(requested === undefined || requested === '' ? 'Create a Project first.' : `Project ${requested} was not found.`);
  return project;
}

async function createRemoteProject(name: string, description = 'Local FACTORY project'): Promise<{ project: import('../src/domain/types.js').ProjectRecord; artifactId: string }> {
  const project = await requestJson<import('../src/domain/types.js').ProjectRecord>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
  await requestJson(`/api/projects/${encodeURIComponent(project.id)}/files`, {
    method: 'PUT',
    headers: projectHeaders(project.id),
    body: JSON.stringify({ path: 'factory.yaml', content: renderWorkspaceProjectFile(project.id, project.name, project.description) }),
  });
  const artifact = await compileRemoteProject(project.id);
  return { project, artifactId: artifact.id };
}

async function createRemoteWorkflow(projectId: string, name: string, requestedId?: string): Promise<{ workflowId: string; artifactId: string }> {
  const headers = projectHeaders(projectId);
  const [projects, files, workflows] = await Promise.all([
    requestJson<{ items: import('../src/domain/types.js').ProjectRecord[] }>('/api/projects'),
    requestJson<{ items: import('../src/domain/types.js').ProjectFileRecord[] }>(`/api/projects/${encodeURIComponent(projectId)}/files`, { headers }),
    requestJson<{ items: import('../src/domain/types.js').WorkflowDefinition[] }>('/api/workflows', { headers }),
  ]);
  const listedProjectFile = files.items.find((file) => file.path === 'factory.yaml' || file.path === 'factory.yml');
  let projectFile: import('../src/domain/types.js').ProjectFileRecord;
  if (listedProjectFile === undefined) {
    const project = projects.items.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error(`Project ${projectId} was not found.`);
    projectFile = await requestJson<import('../src/domain/types.js').ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ path: 'factory.yaml', content: renderWorkspaceProjectFile(project.id, project.name, project.description) }),
    });
  } else projectFile = await requestJson<import('../src/domain/types.js').ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(listedProjectFile.path)}`, { headers });
  const baseId = authoringSlug(requestedId || name, 'workflow');
  const existingIds = new Set(workflows.items.map((workflow) => workflow.id));
  let workflowId = baseId;
  for (let suffix = 2; existingIds.has(workflowId); suffix += 1) workflowId = `${baseId}-${suffix}`;
  const workflowPath = workflowResourcePath(workflowId);
  const canvasPath = canvasResourcePath(workflowId);
  const factorySource = addProjectResourcePaths(projectFile.content, [workflowPath, canvasPath]);
  await requestJson(`/api/projects/${encodeURIComponent(projectId)}/files/batch`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ files: [
      { path: 'factory.yaml', content: factorySource, expectedSha256: projectFile.sha256 },
      { path: workflowPath, content: renderStarterWorkflowFile(workflowId, name), expectedSha256: null },
      { path: canvasPath, content: renderStarterCanvasFile(workflowId, name), expectedSha256: null },
    ] }),
  });
  const artifact = await compileRemoteProject(projectId);
  return { workflowId, artifactId: artifact.id };
}

async function editLocalFile(filePath: string): Promise<void> {
  const inputStat = await stat(filePath);
  if (!inputStat.isFile()) throw new Error(`Only files can be edited: ${filePath}`);
  const original = await readFile(filePath, 'utf8');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-author-'));
  const temporaryPath = path.join(directory, path.basename(filePath));
  await writeFile(temporaryPath, original, 'utf8');
  try {
    const editor = editorInvocation(temporaryPath);
    const result = spawnSync(editor.command, editor.args, { stdio: 'inherit', env: process.env });
    if (result.error !== undefined) throw new Error(`Unable to open ${editor.command}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${editor.command} exited with status ${String(result.status ?? 1)}.`);
    const updated = await readFile(temporaryPath, 'utf8');
    if (updated === original) {
      console.log(`FACTORY no changes: ${filePath}`);
      return;
    }
    const relativePath = path.relative(process.cwd(), filePath).replaceAll(path.sep, '/');
    if (/^(?:factory|project)\.ya?ml$/i.test(path.basename(filePath))) {
      parseProjectYaml(updated, { tenantId: 'tenant-local' });
    } else {
      try {
        parseResourceFile({ path: relativePath, source: updated });
      } catch (resourceError) {
        // The pre-envelope aggregate project format is still supported for
        // local edits, including examples with a custom filename.
        try {
          parseProjectYaml(updated, { tenantId: 'tenant-local' });
        } catch {
          throw resourceError;
        }
      }
    }
    await writeFile(filePath, updated, 'utf8');
    console.log(`FACTORY saved and validated ${filePath}.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function terminalSnapshot(runId?: string, requestedProjectId?: string): Promise<TerminalSnapshot> {
  const projects = await requestJson<{ items: import('../src/domain/types.js').ProjectRecord[] }>('/api/projects');
  const preferredId = requestedProjectId ?? process.env.FACTORY_PROJECT_ID?.trim();
  const project = projects.items.find((candidate) => candidate.id === preferredId) ?? (preferredId === undefined || preferredId === '' ? projects.items[0] : undefined);
  if (project === undefined && preferredId !== undefined && preferredId !== '') throw new Error(`Project ${preferredId} was not found.`);
  const projectId = project?.id;
  const scoped = { headers: projectHeaders(projectId) };
  const filesPromise = projectId === undefined
    ? Promise.resolve({ items: [] as import('../src/domain/types.js').ProjectFileRecord[] })
    : requestJson<{ items: import('../src/domain/types.js').ProjectFileRecord[] }>(`/api/projects/${encodeURIComponent(projectId)}/files`, scoped);
  if (runId !== undefined) {
    const [run, events, approvals, deployments, workflows, connections, proposals, metrics, files] = await Promise.all([
      requestJson<import('../src/domain/types.js').RunRecord>(`/api/runs/${encodeURIComponent(runId)}`, scoped),
      requestJson<{ items: import('../src/domain/types.js').RunEvent[] }>(`/api/events?runId=${encodeURIComponent(runId)}`, scoped),
      requestJson<{ items: import('../src/domain/types.js').ApprovalRecord[] }>(`/api/approvals?runId=${encodeURIComponent(runId)}`, scoped),
      requestJson<{ items: import('../src/domain/types.js').DeploymentRecord[] }>('/api/deployments', scoped),
      requestJson<{ items: import('../src/domain/types.js').WorkflowDefinition[] }>('/api/workflows', scoped),
      requestJson<{ items: import('../src/domain/types.js').ConnectionRecord[] }>('/api/connections', scoped),
      projectId === undefined ? Promise.resolve({ items: [] as import('../src/domain/types.js').AuthoringProposal[] }) : requestJson<{ items: import('../src/domain/types.js').AuthoringProposal[] }>(`/api/projects/${encodeURIComponent(projectId)}/authoring/proposals`, scoped),
      requestJson<import('../src/domain/types.js').FactoryMetrics>('/api/factory/metrics', scoped),
      filesPromise,
    ]);
    return { runs: [run], approvals: approvals.items, deployments: deployments.items, workflows: workflows.items, connections: connections.items, proposals: proposals.items, metrics, events: events.items, files: files.items, projects: projects.items, projectId };
  }
  const [runs, approvals, deployments, workflows, connections, proposals, metrics, files] = await Promise.all([
    requestJson<{ items: import('../src/domain/types.js').RunRecord[] }>('/api/runs', scoped),
    requestJson<{ items: import('../src/domain/types.js').ApprovalRecord[] }>('/api/approvals', scoped),
    requestJson<{ items: import('../src/domain/types.js').DeploymentRecord[] }>('/api/deployments', scoped),
    requestJson<{ items: import('../src/domain/types.js').WorkflowDefinition[] }>('/api/workflows', scoped),
    requestJson<{ items: import('../src/domain/types.js').ConnectionRecord[] }>('/api/connections', scoped),
    projectId === undefined ? Promise.resolve({ items: [] as import('../src/domain/types.js').AuthoringProposal[] }) : requestJson<{ items: import('../src/domain/types.js').AuthoringProposal[] }>(`/api/projects/${encodeURIComponent(projectId)}/authoring/proposals`, scoped),
    requestJson<import('../src/domain/types.js').FactoryMetrics>('/api/factory/metrics', scoped),
    filesPromise,
  ]);
  return { runs: runs.items, approvals: approvals.items, deployments: deployments.items, workflows: workflows.items, connections: connections.items, proposals: proposals.items, metrics, files: files.items, projects: projects.items, projectId };
}

async function runObserve(args: FactoryArgs): Promise<void> {
  const follow = args.follow && !args.once;
  let first = true;
  do {
    try {
      const snapshot = await terminalSnapshot(args.runId, args.projectId);
      process.stdout.write(renderTerminalSnapshot(snapshot, { clear: follow || !first, runId: args.runId }));
      process.stdout.write('\n');
      first = false;
      if (!follow || (args.runId !== undefined && ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(snapshot.runs[0]?.status ?? ''))) return;
    } catch (error) {
      if (!follow || first) throw error;
      process.stdout.write(`\nFACTORY observe warning: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await sleep(args.intervalMs);
  } while (true);
}

async function runTui(args: FactoryArgs, initialPage: TerminalPortalPage = 'home'): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.once;
  let activeProjectId = args.projectId ?? process.env.FACTORY_PROJECT_ID?.trim();
  let snapshot = await terminalSnapshot(args.runId, activeProjectId);
  activeProjectId = snapshot.projectId;
  let state: TerminalPortalState = { page: initialPage, cursor: 0 };
  const render = () => {
    process.stdout.write(renderTerminalPortal(snapshot, state, { clear: interactive }));
    process.stdout.write('\n');
  };
  if (!interactive) { render(); return; }
  let refreshing = false;
  let authoring = false;
  let actionGeneration = 0;
  let activePrompt: { resolve: (value: string | undefined) => void } | undefined;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      snapshot = await terminalSnapshot(args.runId, activeProjectId);
      activeProjectId = snapshot.projectId;
    } catch (error) { snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }; }
    refreshing = false;
    render();
  };
  const decide = async (decision: 'approve' | 'deny') => {
    const selected = state.page === 'approvals' ? snapshot.approvals[state.cursor] : undefined;
    const approval = selected?.decision === 'pending' ? selected : pendingApproval(snapshot);
    if (approval === undefined) return;
    try {
      await requestJson(`/api/runs/${encodeURIComponent(approval.runId)}/${decision}`, { method: 'POST', headers: projectHeaders(activeProjectId), body: JSON.stringify({ actor: 'factory-tui', reason: decision === 'deny' ? 'Denied from terminal monitor.' : 'Approved from terminal monitor.' }) });
    } catch (error) {
      snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) };
    }
    await refresh();
  };
  const refreshPage = async () => {
    try {
      snapshot = await terminalSnapshot(state.page === 'run-detail' ? state.selectedRunId : undefined, activeProjectId);
      activeProjectId = snapshot.projectId;
      state = { ...state, error: undefined, cursor: Math.min(state.cursor, Math.max(0, portalItemCount(snapshot, state.page, state.selectedWorkflowId) - 1)) };
    } catch (error) {
      state = { ...state, error: error instanceof Error ? error.message : String(error) };
    }
    render();
  };
  const openSourceEditor = async (file: import('../src/domain/types.js').ProjectFileRecord, returnPage: 'project' | 'workflow' | 'tree'): Promise<void> => {
    if (activeProjectId === undefined) throw new Error('Create or select a Project first.');
    const source = await requestJson<import('../src/domain/types.js').ProjectFileRecord>(`/api/projects/${encodeURIComponent(activeProjectId)}/files?path=${encodeURIComponent(file.path)}`, {
      headers: projectHeaders(activeProjectId),
    });
    state = {
      page: 'source-editor',
      cursor: 0,
      editor: {
        filePath: source.path,
        content: source.content ?? '',
        originalContent: source.content ?? '',
        expectedSha256: source.sha256,
        cursorOffset: 0,
        returnPage,
      },
    };
    render();
  };
  const promptValue = (question: { label: string; defaultValue?: string }): Promise<string | undefined> => new Promise((resolve) => {
    const prompt: TerminalPrompt = { label: question.label, value: '', ...(question.defaultValue === undefined ? {} : { defaultValue: question.defaultValue }) };
    activePrompt = { resolve };
    state = { ...state, prompt };
    render();
  });
  const promptValues = async (questions: Array<{ label: string; defaultValue?: string }>): Promise<string[]> => {
    const answers: string[] = [];
    for (const question of questions) {
      const answer = await promptValue(question);
      if (answer === undefined) return [];
      answers.push(answer.trim() || question.defaultValue || '');
    }
    return answers;
  };
  const performAuthoring = async (action: () => Promise<string | undefined>): Promise<void> => {
    if (authoring) return;
    const generation = ++actionGeneration;
    authoring = true;
    try {
      const notice = await action();
      if (generation !== actionGeneration) return;
      await refreshPage();
      if (notice !== undefined) snapshot = { ...snapshot, error: undefined, notice };
    } catch (error) {
      if (generation !== actionGeneration) return;
      snapshot = { ...snapshot, notice: undefined, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (generation === actionGeneration) {
        authoring = false;
        render();
      }
    }
  };
  const compileProject = async (): Promise<{ id: string }> => {
    if (activeProjectId === undefined) throw new Error('Create or select a Project first.');
    return compileRemoteProject(activeProjectId);
  };
  const createProject = async (): Promise<string | undefined> => {
    const [name, description] = await promptValues([
      { label: 'Project name' },
      { label: 'Description', defaultValue: 'Local FACTORY Project' },
    ]);
    if (name === undefined || name === '') return undefined;
    const created = await createRemoteProject(name, description);
    const project = created.project;
    activeProjectId = project.id;
    state = { page: 'project', cursor: 0 };
    return `Created Project ${project.name} and compiled ${created.artifactId}.`;
  };
  const createWorkflow = async (): Promise<string | undefined> => {
    if (activeProjectId === undefined) throw new Error('Create or select a Project first.');
    const [name] = await promptValues([{ label: 'Workflow name' }]);
    if (name === undefined || name === '') return undefined;
    const suggestedId = authoringSlug(name, 'workflow');
    const [requestedId] = await promptValues([{ label: 'Workflow id', defaultValue: suggestedId }]);
    const created = await createRemoteWorkflow(activeProjectId, name, requestedId);
    state = { page: 'workflow', cursor: 0 };
    return `Created workflow ${name} (${created.workflowId}) and compiled ${created.artifactId}.`;
  };
  const switchProject = async (): Promise<string | undefined> => {
    const projects = snapshot.projects ?? [];
    if (projects.length < 2) return 'Only one Project is available.';
    const currentIndex = projects.findIndex((project) => project.id === activeProjectId);
    const next = projects[(currentIndex + 1 + projects.length) % projects.length];
    if (next === undefined) return undefined;
    activeProjectId = next.id;
    state = { ...state, cursor: 0 };
    return `Switched to Project ${next.name}.`;
  };
  const selectedWorkflow = (): import('../src/domain/types.js').WorkflowDefinition | undefined => state.selectedWorkflowId === undefined
    ? snapshot.workflows?.[state.cursor]
    : snapshot.workflows?.find((workflow) => workflow.id === state.selectedWorkflowId);
  const authorWithAi = async (): Promise<string | undefined> => {
    if (activeProjectId === undefined) throw new Error('Create or select a Project first.');
    const workflow = selectedWorkflow();
    if (workflow === undefined) throw new Error('Select a Workflow first.');
    const [goal] = await promptValues([{ label: `Describe the change to ${workflow.name}` }]);
    if (goal === undefined || goal.length < 10) return undefined;
    const proposal = await requestJson<import('../src/domain/types.js').AuthoringProposal>(`/api/projects/${encodeURIComponent(activeProjectId)}/authoring/proposals`, {
      method: 'POST',
      headers: projectHeaders(activeProjectId),
      body: JSON.stringify({ workflowId: workflow.id, goal }),
    });
    state = { page: 'proposal-detail', cursor: 0, selectedProposalId: proposal.id };
    return `AI proposal ${proposal.id} is ${proposal.status}; review its semantic diff before approval.`;
  };
  const updateAuthoringProposal = async (action: 'validate' | 'approve' | 'apply' | 'reject'): Promise<string | undefined> => {
    if (activeProjectId === undefined || state.selectedProposalId === undefined) throw new Error('Select an authoring proposal first.');
    const proposal = await requestJson<import('../src/domain/types.js').AuthoringProposal>(`/api/projects/${encodeURIComponent(activeProjectId)}/authoring/proposals/${encodeURIComponent(state.selectedProposalId)}/${action}`, {
      method: 'POST',
      headers: projectHeaders(activeProjectId),
      body: JSON.stringify({ actor: 'factory-terminal' }),
    });
    return `Proposal ${proposal.id} is now ${proposal.status}${proposal.artifactId === undefined ? '' : `; compiled ${proposal.artifactId}`}.`;
  };
  const runSelectedWorkflow = async (): Promise<string | undefined> => {
    if (activeProjectId === undefined) throw new Error('Create or select a Project first.');
    const workflow = selectedWorkflow();
    if (workflow === undefined) throw new Error('Select a workflow first.');
    const artifact = await compileProject();
    const run = await requestJson<import('../src/domain/types.js').RunRecord>(`/api/workflows/${encodeURIComponent(workflow.id)}/runs`, {
      method: 'POST',
      headers: projectHeaders(activeProjectId),
      body: JSON.stringify({ artifactId: artifact.id, environment: process.env.FACTORY_ENVIRONMENT?.trim() || 'local' }),
    });
    state = { page: 'run-detail', cursor: 0, selectedRunId: run.id };
    return `Started ${workflow.name} as run ${run.id}.`;
  };
  const saveSourceEditor = async (): Promise<string | undefined> => {
    const editor = state.editor;
    if (state.page !== 'source-editor' || editor === undefined || activeProjectId === undefined) throw new Error('No source file is open.');
    if (editor.content === editor.originalContent) return `${editor.filePath} has no unsaved changes.`;
    const saved = await requestJson<import('../src/domain/types.js').ProjectFileRecord>(`/api/projects/${encodeURIComponent(activeProjectId)}/files`, {
      method: 'PUT',
      headers: projectHeaders(activeProjectId),
      body: JSON.stringify({ path: editor.filePath, content: editor.content, expectedSha256: editor.expectedSha256 }),
    });
    state = { ...state, editor: { ...editor, originalContent: editor.content, expectedSha256: saved.sha256 } };
    const artifact = await compileProject();
    return `Saved ${editor.filePath} and compiled ${artifact.id}.`;
  };
  const moveCursor = (delta: number) => {
    const count = portalItemCount(snapshot, state.page, state.selectedWorkflowId);
    if (count === 0) return;
    state = { ...state, cursor: (state.cursor + delta + count) % count };
    render();
  };
  const select = async () => {
    if (state.page === 'home') {
      const nextPage: TerminalPortalPage[] = ['project', 'workflow', 'runs', 'approvals', 'deployments', 'connections', 'proposals', 'factory', 'portals'];
      state = { page: nextPage[state.cursor]!, cursor: 0 };
      await refreshPage();
      return;
    }
    if (state.page === 'project') {
      render();
      return;
    }
    if (state.page === 'workflow' || state.page === 'tree') {
      const workflow = snapshot.workflows?.[state.cursor];
      if (workflow !== undefined) {
        state = { page: 'workflow-detail', cursor: 0, selectedWorkflowId: workflow.id };
        render();
      } else if (activeProjectId === undefined) {
        state = { page: 'project', cursor: 0 };
        await refreshPage();
      } else {
        await performAuthoring(createWorkflow);
      }
      return;
    }
    if (state.page === 'workflow-detail') {
      const workflow = selectedWorkflow();
      const node = workflow?.nodes[state.cursor];
      if (workflow !== undefined && node !== undefined) state = { page: 'work-unit-detail', cursor: 0, selectedWorkflowId: workflow.id, selectedNodeId: node.id };
      render();
      return;
    }
    if (state.page === 'proposals') {
      const proposal = snapshot.proposals?.[state.cursor];
      if (proposal !== undefined) state = { page: 'proposal-detail', cursor: 0, selectedProposalId: proposal.id };
      render();
      return;
    }
    if (state.page === 'runs') {
      const run = snapshot.runs[state.cursor];
      if (run !== undefined) { state = { page: 'run-detail', cursor: 0, selectedRunId: run.id }; await refreshPage(); }
      return;
    }
    if (state.page === 'portals') {
      const nextPage: TerminalPortalPage[] = ['runs', 'workflow', 'deployments', 'factory'];
      state = { page: nextPage[state.cursor]!, cursor: 0 };
      await refreshPage();
      return;
    }
    if (state.page === 'run-detail') return;
    render();
  };
  const selectSafely = () => {
    void select().catch((error) => {
      snapshot = { ...snapshot, notice: undefined, error: error instanceof Error ? error.message : String(error) };
      render();
    });
  };
  const back = () => {
    const discarded = state.page === 'source-editor' && state.editor !== undefined && state.editor.content !== state.editor.originalContent;
    state = backTerminalState(state);
    if (discarded) snapshot = { ...snapshot, notice: 'Discarded unsaved source changes.', error: undefined };
    void refreshPage();
  };
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => { if (!authoring && state.page !== 'source-editor') void refreshPage(); }, args.intervalMs);
    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === '\u001b') {
        if (activePrompt !== undefined) {
          const prompt = activePrompt;
          activePrompt = undefined;
          state = { ...state, prompt: undefined };
          prompt.resolve(undefined);
        }
        actionGeneration += 1;
        authoring = false;
        back();
        return;
      }
      if (activePrompt !== undefined) {
        if (key === '\r' || key === '\n') {
          const prompt = activePrompt;
          const value = state.prompt?.value ?? '';
          activePrompt = undefined;
          state = { ...state, prompt: undefined };
          prompt.resolve(value);
        } else if (key === '\u007f' || key === '\b') state = { ...state, prompt: state.prompt === undefined ? undefined : { ...state.prompt, value: state.prompt.value.slice(0, -1) } };
        else {
          const inserted = key.replace(/[\u0000-\u001f\u007f]/g, '');
          if (inserted !== '' && state.prompt !== undefined) state = { ...state, prompt: { ...state.prompt, value: `${state.prompt.value}${inserted}` } };
        }
        render();
        return;
      }
      if (state.page === 'source-editor') {
        if (key === '\u0013') void performAuthoring(saveSourceEditor);
        else if (!authoring) {
          if (key === '\u0003') {
            clearInterval(interval);
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdin.off('data', onData);
            resolve();
          } else {
            state = { ...state, editor: state.editor === undefined ? undefined : editTerminalSource(state.editor, key) };
            render();
          }
        }
        return;
      }
      if (authoring) return;
      if (key === 'q' || key === '\u0003') {
        clearInterval(interval);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        resolve();
      } else if (key === 'r') void refreshPage();
      else if (key === 'n' && state.page === 'project') void performAuthoring(createProject);
      else if (key === 'n' && (state.page === 'workflow' || state.page === 'tree')) void performAuthoring(createWorkflow);
      else if (key === 'w' && state.page === 'project') void performAuthoring(createWorkflow);
      else if (key === 's' && (state.page === 'project' || state.page === 'workflow' || state.page === 'tree')) void performAuthoring(switchProject);
      else if (key === 'a' && (state.page === 'workflow' || state.page === 'tree' || state.page === 'workflow-detail')) void performAuthoring(authorWithAi);
      else if (key === 'a' && state.page === 'proposal-detail') void performAuthoring(() => updateAuthoringProposal('approve'));
      else if (key === 'y' && state.page === 'proposal-detail') void performAuthoring(() => updateAuthoringProposal('apply'));
      else if (key === 'd' && state.page === 'proposal-detail') void performAuthoring(() => updateAuthoringProposal('reject'));
      else if (key === 'v' && state.page === 'proposal-detail') void performAuthoring(() => updateAuthoringProposal('validate'));
      else if (key === 'v' && (state.page === 'project' || state.page === 'workflow' || state.page === 'tree')) void performAuthoring(async () => {
        const artifact = await compileProject();
        return `Project validated and compiled as ${artifact.id}.`;
      });
      else if (key === 'p' && (state.page === 'workflow' || state.page === 'tree' || state.page === 'workflow-detail')) void performAuthoring(runSelectedWorkflow);
      else if (key === 'o' && state.page === 'project') {
        const file = snapshot.files?.[state.cursor];
        if (file !== undefined) void openSourceEditor(file, 'project');
      }
      else if (key === 'o' && (state.page === 'workflow' || state.page === 'tree' || state.page === 'workflow-detail')) {
        const workflow = selectedWorkflow();
        const file = workflow === undefined ? undefined : snapshot.files?.find((candidate) => candidate.path === `workflows/${workflow.id}.workflow.yaml` || candidate.path === `workflows/${workflow.id}.workflow.yml`);
        if (file !== undefined) void openSourceEditor(file, 'workflow');
      }
      else if (key === 'a') void decide('approve');
      else if (key === 'd') void decide('deny');
      else if (key === '\u001b[A' || key === 'k') moveCursor(-1);
      else if (key === '\u001b[B' || key === 'j') moveCursor(1);
      else if (key === '\r' || key === '\n') selectSafely();
      else if (key === '\u007f') back();
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
  });
}

async function runRunControl(args: FactoryArgs): Promise<void> {
  if (args.runId === undefined) throw new Error(`${args.command} requires a run id.`);
  const routeByCommand: Record<string, string> = { approve: 'approve', deny: 'deny', cancel: 'cancel', pause: 'pause', resume: 'resume' };
  const route = routeByCommand[args.command];
  const body = ['approve', 'deny'].includes(args.command) ? { actor: 'factory-cli', ...(args.reason === undefined ? {} : { reason: args.reason }) } : undefined;
  const result = await requestJson<import('../src/domain/types.js').RunRecord>(`/api/runs/${encodeURIComponent(args.runId)}/${route}`, { method: 'POST', headers: projectHeaders(args.projectId ?? process.env.FACTORY_PROJECT_ID?.trim()), body: JSON.stringify(body ?? {}) });
  const verb = ({ approve: 'approved', deny: 'denied', cancel: 'cancelled', pause: 'paused', resume: 'resumed' } as const)[args.command as 'approve' | 'deny' | 'cancel' | 'pause' | 'resume'];
  console.log(`FACTORY ${verb} run ${args.runId}: ${result.status}`);
}

function printAuthoringProposal(proposal: import('../src/domain/types.js').AuthoringProposal): void {
  console.log(`${proposal.id} · ${proposal.status} · ${proposal.changes.length} file change${proposal.changes.length === 1 ? '' : 's'}`);
  console.log(`Goal: ${proposal.goal}`);
  for (const line of proposal.semanticDiff) console.log(`  ${line}`);
  for (const issue of proposal.issues) console.log(`  ${issue.severity.toUpperCase()} ${issue.path}:${issue.line} ${issue.message}`);
  if (proposal.artifactId !== undefined) console.log(`Artifact: ${proposal.artifactId}`);
}

async function runAuthoringCommand(args: FactoryArgs): Promise<void> {
  await waitForDashboard();
  const project = await resolveRemoteProject(args.projectId);
  const headers = projectHeaders(project.id);
  const base = `/api/projects/${encodeURIComponent(project.id)}/authoring/proposals`;
  if (args.authoringAction === 'list') {
    const proposals = await requestJson<{ items: import('../src/domain/types.js').AuthoringProposal[] }>(base, { headers });
    if (proposals.items.length === 0) console.log(`No AI authoring proposals for ${project.name}.`);
    for (const proposal of proposals.items) console.log(`${proposal.id.padEnd(48)} ${proposal.status.padEnd(10)} ${proposal.changes.length} files · ${proposal.goal}`);
    return;
  }
  if (args.authoringAction === 'propose') {
    const proposal = await requestJson<import('../src/domain/types.js').AuthoringProposal>(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workflowId: args.workflowId, goal: args.goal }),
    });
    printAuthoringProposal(proposal);
    console.log(`Next: factory author approve ${proposal.id} --project ${project.id}`);
    return;
  }
  if (args.authoringAction === 'import') {
    if (args.resourcePath === undefined) throw new Error('Select an AI authoring proposal bundle.');
    const bundleSource = await readFile(path.resolve(args.resourcePath), 'utf8');
    let bundle: unknown;
    try { bundle = JSON.parse(bundleSource); } catch { throw new Error('The authoring proposal bundle must be valid JSON.'); }
    const proposal = await requestJson<import('../src/domain/types.js').AuthoringProposal>(base, {
      method: 'POST',
      headers,
      body: JSON.stringify(bundle),
    });
    printAuthoringProposal(proposal);
    console.log(`Next: factory author approve ${proposal.id} --project ${project.id}`);
    return;
  }
  if (args.proposalId === undefined || args.authoringAction === undefined) throw new Error('Select an authoring proposal action and id.');
  if (args.authoringAction === 'show') {
    printAuthoringProposal(await requestJson<import('../src/domain/types.js').AuthoringProposal>(`${base}/${encodeURIComponent(args.proposalId)}`, { headers }));
    return;
  }
  const proposal = await requestJson<import('../src/domain/types.js').AuthoringProposal>(`${base}/${encodeURIComponent(args.proposalId)}/${args.authoringAction}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ actor: 'factory-cli' }),
  });
  printAuthoringProposal(proposal);
}

async function runLifecycle(args: FactoryArgs): Promise<void> {
  switch (args.command) {
    case 'launch':
      compose('up', args);
      await waitForDashboard();
      await runTui({ ...args, command: 'tui' });
      return;
    case 'open':
      await waitForDashboard();
      openDashboard();
      return;
    case 'dashboard':
      await waitForDashboard();
      await runTui(args, 'portals');
      return;
    case 'project':
      await waitForDashboard();
      if (args.authoringAction === 'new') {
        const created = await createRemoteProject(args.name ?? 'Project');
        console.log(`FACTORY created Project ${created.project.name} (${created.project.id}).`);
        console.log(`Compiled artifact: ${created.artifactId}`);
        console.log(`Next: factory workflow new "My workflow" --project ${created.project.id}`);
        return;
      }
      await runTui(args, 'project');
      return;
    case 'author':
      await runAuthoringCommand(args);
      return;
    case 'up':
      compose('up', args);
      await waitForDashboard();
      console.log(`FACTORY is running at ${dashboardUrl}`);
      return;
    case 'deploy':
      compose('up', args);
      await waitForDashboard();
      console.log(`FACTORY deployed locally at ${dashboardUrl}`);
      return;
    case 'down':
      compose('down', args);
      return;
    case 'restart':
      compose('restart', args);
      await waitForDashboard();
      console.log(`FACTORY restarted at ${dashboardUrl}`);
      return;
    case 'status':
      compose('ps', args);
      return;
    case 'logs':
      compose('logs', args);
      return;
    case 'build':
      compose('build', args);
      return;
    case 'observe':
      await runObserve(args);
      return;
    case 'tui':
      await runTui(args);
      return;
    case 'approve':
    case 'deny':
    case 'cancel':
    case 'pause':
    case 'resume':
      await runRunControl(args);
      return;
    default:
      return;
  }
}

async function loadProject(filePath: string) {
  const inputStat = await stat(filePath);
  if (!inputStat.isDirectory()) return parseProjectYaml(await readFile(filePath, 'utf8'), { tenantId: 'tenant-local' });
  const entries = (await readdir(filePath, { recursive: true })).filter((entry) => /\.(yaml|yml|json)$/i.test(entry));
  const resources = await Promise.all(entries.map(async (entry) => ({ path: entry, source: await readFile(path.join(filePath, entry), 'utf8') })));
  return compileResourceFiles(resources, { tenantId: 'tenant-local' });
}

function printWorkflow(parsed: Awaited<ReturnType<typeof loadProject>>): void {
  console.log(`${parsed.project.name} (${parsed.project.id})`);
  for (const workflow of parsed.workflows) {
    console.log(`├─ ${workflow.name} [${workflow.id}]`);
    workflow.nodes.forEach((node, index) => {
      const prefix = index === workflow.nodes.length - 1 ? '└─' : '├─';
      console.log(`│  ${prefix} ${node.label} · ${node.unit?.kind ?? 'unknown'}`);
    });
  }
}

async function runResourceCommand(args: FactoryArgs): Promise<void> {
  if (args.command === 'workflow' && args.authoringAction === 'new') {
    await waitForDashboard();
    const project = await resolveRemoteProject(args.projectId);
    const created = await createRemoteWorkflow(project.id, args.name ?? 'Workflow');
    console.log(`FACTORY created workflow ${created.workflowId} in ${project.name} (${project.id}).`);
    console.log(`Compiled artifact: ${created.artifactId}`);
    console.log(`Next: factory workflow --project ${project.id}`);
    return;
  }
  if (args.resourcePath === undefined) {
    if (args.command === 'workflow') {
      await waitForDashboard();
      await runTui(args, 'workflow');
      return;
    }
    throw new Error(`${args.command} requires a project.yaml or resource directory.`);
  }
  if (args.command === 'edit') {
    await editLocalFile(args.resourcePath);
    return;
  }
  const parsed = await loadProject(args.resourcePath);
  if (args.command === 'validate') {
    console.log(`Valid: ${parsed.project.name} (${parsed.workflows.length} workflow${parsed.workflows.length === 1 ? '' : 's'})`);
    return;
  }
  if (args.command === 'plan' || args.command === 'workflow' || args.command === 'tree') {
    printWorkflow(parsed);
    return;
  }
  const workflow = parsed.workflows.find((candidate) => args.workflowId === undefined || candidate.id === args.workflowId) ?? parsed.workflows[0];
  if (workflow === undefined) throw new Error('No workflow is defined in the project YAML.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-cli-'));
  const store = new JsonStore(path.join(directory, 'state.json'));
  await store.mutate((state) => {
    const seed = createSeedState();
    state.tenants = seed.tenants;
    state.projects = [parsed.project];
    state.workflows = parsed.workflows;
    state.workflowVersions = structuredClone(parsed.workflows);
  });
  const events = new EventService(store);
  const executor = new LocalWorkflowExecutor(store, events);
  const run = await executor.start(workflow);
  let approvalHandled = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.status);
    if (status === 'waiting' && !approvalHandled) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(JSON.stringify({ runId: run.id, workflowId: workflow.id, status, action: 'approval_required' }, null, 2));
        process.exitCode = 3;
        return;
      }
      approvalHandled = true;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const decision = (await prompt.question('Workflow is waiting for approval. Approve? [y/N]: ')).trim().toLowerCase();
      prompt.close();
      if (decision === 'y' || decision === 'yes') await executor.approve(run.id, { actor: 'factory-cli', reason: 'Approved during local CLI execution.' });
      else await executor.deny(run.id, { actor: 'factory-cli', reason: 'Denied during local CLI execution.' });
      continue;
    }
    if (status !== undefined && ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(status)) {
      console.log(JSON.stringify({ runId: run.id, workflowId: workflow.id, status }, null, 2));
      process.exitCode = status === 'succeeded' ? 0 : 2;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for workflow run.');
}

async function main(): Promise<void> {
  const args = parseFactoryArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageText());
    return;
  }
  if (isLifecycleCommand(args.command)) {
    await runLifecycle(args);
    return;
  }
  await runResourceCommand(args);
}

main().catch((error: unknown) => {
  console.error(`FACTORY error: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Run "factory help" for usage.');
  process.exitCode = 1;
});
