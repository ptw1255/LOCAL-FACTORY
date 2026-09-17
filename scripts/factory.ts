import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseProjectYaml } from '../src/declarative/yaml.js';
import { compileResourceFiles } from '../src/declarative/resources.js';
import { EventService } from '../src/observability/event-service.js';
import { LocalWorkflowExecutor } from '../src/runtime/executor.js';
import { JsonStore } from '../src/storage/json-store.js';
import { createSeedState } from '../src/domain/seed.js';
import { browserOpenCommand, composeArguments, parseFactoryArgs, usageText, type FactoryArgs } from './factory-cli.js';
import { pendingApproval, portalItemCount, renderTerminalPortal, renderTerminalSnapshot, type TerminalPortalPage, type TerminalPortalState, type TerminalSnapshot } from './factory-terminal.js';

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
  throw new Error('FACTORY did not become healthy within 90 seconds. Check "/factory logs app".');
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
  const response = await fetch(`${dashboardUrl}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
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

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function terminalSnapshot(runId?: string): Promise<TerminalSnapshot> {
  if (runId !== undefined) {
    const [run, events, approvals, deployments, workflows, connections, proposals, metrics] = await Promise.all([
      requestJson<import('../src/domain/types.js').RunRecord>(`/api/runs/${encodeURIComponent(runId)}`),
      requestJson<{ items: import('../src/domain/types.js').RunEvent[] }>(`/api/events?runId=${encodeURIComponent(runId)}`),
      requestJson<{ items: import('../src/domain/types.js').ApprovalRecord[] }>(`/api/approvals?runId=${encodeURIComponent(runId)}`),
      requestJson<{ items: import('../src/domain/types.js').DeploymentRecord[] }>('/api/deployments'),
      requestJson<{ items: import('../src/domain/types.js').WorkflowDefinition[] }>('/api/workflows'),
      requestJson<{ items: import('../src/domain/types.js').ConnectionRecord[] }>('/api/connections'),
      requestJson<{ items: import('../src/domain/types.js').AgentProposal[] }>('/api/agent/proposals'),
      requestJson<import('../src/domain/types.js').FactoryMetrics>('/api/factory/metrics'),
    ]);
    return { runs: [run], approvals: approvals.items, deployments: deployments.items, workflows: workflows.items, connections: connections.items, proposals: proposals.items, metrics, events: events.items };
  }
  const [runs, approvals, deployments, workflows, connections, proposals, metrics] = await Promise.all([
    requestJson<{ items: import('../src/domain/types.js').RunRecord[] }>('/api/runs'),
    requestJson<{ items: import('../src/domain/types.js').ApprovalRecord[] }>('/api/approvals'),
    requestJson<{ items: import('../src/domain/types.js').DeploymentRecord[] }>('/api/deployments'),
    requestJson<{ items: import('../src/domain/types.js').WorkflowDefinition[] }>('/api/workflows'),
    requestJson<{ items: import('../src/domain/types.js').ConnectionRecord[] }>('/api/connections'),
    requestJson<{ items: import('../src/domain/types.js').AgentProposal[] }>('/api/agent/proposals'),
    requestJson<import('../src/domain/types.js').FactoryMetrics>('/api/factory/metrics'),
  ]);
  return { runs: runs.items, approvals: approvals.items, deployments: deployments.items, workflows: workflows.items, connections: connections.items, proposals: proposals.items, metrics };
}

async function runObserve(args: FactoryArgs): Promise<void> {
  const follow = args.follow && !args.once;
  let first = true;
  do {
    try {
      const snapshot = await terminalSnapshot(args.runId);
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
  let snapshot = await terminalSnapshot(args.runId);
  let state: TerminalPortalState = { page: initialPage, cursor: 0 };
  const render = () => {
    process.stdout.write(renderTerminalPortal(snapshot, state, { clear: interactive }));
    process.stdout.write('\n');
  };
  if (!interactive) { render(); return; }
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { snapshot = await terminalSnapshot(args.runId); } catch (error) { snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }; }
    refreshing = false;
    render();
  };
  const decide = async (decision: 'approve' | 'deny') => {
    const selected = state.page === 'approvals' ? snapshot.approvals[state.cursor] : undefined;
    const approval = selected?.decision === 'pending' ? selected : pendingApproval(snapshot);
    if (approval === undefined) return;
    try {
      await requestJson(`/api/runs/${encodeURIComponent(approval.runId)}/${decision}`, { method: 'POST', body: JSON.stringify({ actor: 'factory-tui', reason: decision === 'deny' ? 'Denied from terminal monitor.' : 'Approved from terminal monitor.' }) });
    } catch (error) {
      snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) };
    }
    await refresh();
  };
  const refreshPage = async () => {
    try {
      snapshot = await terminalSnapshot(state.page === 'run-detail' ? state.selectedRunId : undefined);
      state = { ...state, error: undefined, cursor: Math.min(state.cursor, Math.max(0, portalItemCount(snapshot, state.page) - 1)) };
    } catch (error) {
      state = { ...state, error: error instanceof Error ? error.message : String(error) };
    }
    render();
  };
  const moveCursor = (delta: number) => {
    const count = portalItemCount(snapshot, state.page);
    if (count === 0) return;
    state = { ...state, cursor: (state.cursor + delta + count) % count };
    render();
  };
  const select = async () => {
    if (state.page === 'home') {
      const nextPage: TerminalPortalPage[] = ['workspace', 'tree', 'runs', 'approvals', 'deployments', 'connections', 'proposals', 'factory', 'portals'];
      state = { page: nextPage[state.cursor]!, cursor: 0 };
      await refreshPage();
      return;
    }
    if (state.page === 'runs') {
      const run = snapshot.runs[state.cursor];
      if (run !== undefined) { state = { page: 'run-detail', cursor: 0, selectedRunId: run.id }; await refreshPage(); }
      return;
    }
    if (state.page === 'portals') {
      const nextPage: TerminalPortalPage[] = ['runs', 'tree', 'deployments', 'factory'];
      state = { page: nextPage[state.cursor]!, cursor: 0 };
      await refreshPage();
      return;
    }
    if (state.page === 'run-detail') return;
    render();
  };
  const back = () => {
    if (state.page === 'home') return;
    state = state.page === 'run-detail' ? { page: 'runs', cursor: 0 } : { page: 'home', cursor: 0 };
    void refreshPage();
  };
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => { void refreshPage(); }, args.intervalMs);
    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === 'q' || key === '\u0003') {
        clearInterval(interval);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        resolve();
      } else if (key === 'r') void refreshPage();
      else if (key === 'a') void decide('approve');
      else if (key === 'd') void decide('deny');
      else if (key === '\u001b[A' || key === 'k') moveCursor(-1);
      else if (key === '\u001b[B' || key === 'j') moveCursor(1);
      else if (key === '\r' || key === '\n') void select();
      else if (key === '\u001b' || key === '\u007f') back();
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
  const result = await requestJson<import('../src/domain/types.js').RunRecord>(`/api/runs/${encodeURIComponent(args.runId)}/${route}`, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const verb = args.command === 'approve' ? 'approved' : args.command === 'deny' ? 'denied' : `${args.command}ed`;
  console.log(`FACTORY ${verb} run ${args.runId}: ${result.status}`);
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

function printTree(parsed: Awaited<ReturnType<typeof loadProject>>): void {
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
  if (args.resourcePath === undefined) throw new Error(`${args.command} requires a project.yaml or resource directory.`);
  const parsed = await loadProject(args.resourcePath);
  if (args.command === 'validate') {
    console.log(`Valid: ${parsed.project.name} (${parsed.workflows.length} workflow${parsed.workflows.length === 1 ? '' : 's'})`);
    return;
  }
  if (args.command === 'plan' || args.command === 'tree') {
    printTree(parsed);
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await store.read((state) => state.runs.find((candidate) => candidate.id === run.id)?.status);
    if (status !== undefined && ['succeeded', 'failed', 'cancelled'].includes(status)) {
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
  if (args.command === 'launch' || ['open', 'dashboard', 'up', 'down', 'restart', 'status', 'logs', 'build', 'deploy', 'observe', 'tui', 'approve', 'deny', 'cancel', 'pause', 'resume'].includes(args.command)) {
    await runLifecycle(args);
    return;
  }
  await runResourceCommand(args);
}

main().catch((error: unknown) => {
  console.error(`FACTORY error: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Run "/factory help" for usage.');
  process.exitCode = 1;
});
