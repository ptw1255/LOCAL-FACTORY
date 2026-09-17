import type { AgentProposal, ApprovalRecord, ConnectionRecord, DeploymentRecord, FactoryMetrics, RunEvent, RunRecord, WorkflowDefinition } from '../src/domain/types.js';
import { factoryBanner } from './factory-cli.js';

export interface TerminalSnapshot {
  runs: RunRecord[];
  approvals: ApprovalRecord[];
  deployments: DeploymentRecord[];
  workflows?: WorkflowDefinition[];
  connections?: ConnectionRecord[];
  proposals?: AgentProposal[];
  metrics?: FactoryMetrics;
  events?: RunEvent[];
  error?: string;
}

export type TerminalPortalPage = 'home' | 'workspace' | 'tree' | 'runs' | 'approvals' | 'deployments' | 'connections' | 'proposals' | 'factory' | 'portals' | 'run-detail';

export interface TerminalPortalState {
  page: TerminalPortalPage;
  cursor: number;
  selectedRunId?: string;
  error?: string;
}

const terminalReset = '\u001b[0m';
const terminalDim = '\u001b[2m';
const terminalPurple = '\u001b[35m';
const terminalBlue = '\u001b[36m';
const terminalGreen = '\u001b[32m';
const terminalYellow = '\u001b[33m';
const terminalRed = '\u001b[31m';

function colorStatus(status: string): string {
  const color = ['succeeded', 'approved', 'live', 'healthy'].includes(status)
    ? terminalGreen
    : ['failed', 'denied', 'degraded'].includes(status)
      ? terminalRed
      : ['waiting', 'paused', 'pending', 'starting'].includes(status)
        ? terminalYellow
        : terminalBlue;
  return `${color}${status}${terminalReset}`;
}

function short(value: string, length = 22): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`;
}

function timestamp(value?: string): string {
  if (value === undefined) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function renderTerminalSnapshot(snapshot: TerminalSnapshot, options: { clear?: boolean; interactive?: boolean; runId?: string } = {}): string {
  const lines: string[] = [];
  if (options.clear !== false) lines.push('\u001b[2J\u001b[H');
  lines.push(factoryBanner());
  lines.push(`${terminalDim}· terminal control plane${terminalReset}`);
  if (snapshot.error !== undefined) lines.push(`${terminalRed}Error:${terminalReset} ${snapshot.error}`);
  lines.push('');
  lines.push(`${terminalBlue}RUNS${terminalReset} ${terminalDim}(${snapshot.runs.length})${terminalReset}`);
  if (snapshot.runs.length === 0) lines.push('  No runs recorded.');
  for (const run of snapshot.runs.slice(0, 12)) {
    lines.push(`  ${short(run.id, 18).padEnd(18)} ${short(run.workflowName, 28).padEnd(28)} ${colorStatus(run.status).padEnd(20)} ${short(run.environment ?? 'local', 10).padEnd(10)} ${timestamp(run.startedAt)}`);
  }
  lines.push('');
  lines.push(`${terminalYellow}APPROVALS${terminalReset} ${terminalDim}(${snapshot.approvals.length})${terminalReset}`);
  const pending = snapshot.approvals.filter((approval) => approval.decision === 'pending');
  if (snapshot.approvals.length === 0) lines.push('  No approvals recorded.');
  for (const approval of snapshot.approvals.slice(0, 12)) {
    lines.push(`  ${short(approval.id, 18).padEnd(18)} run ${short(approval.runId, 18).padEnd(18)} ${short(approval.operation, 20).padEnd(20)} ${colorStatus(approval.decision)}`);
  }
  lines.push('');
  lines.push(`${terminalBlue}DEPLOYMENTS${terminalReset} ${terminalDim}(${snapshot.deployments.length})${terminalReset}`);
  if (snapshot.deployments.length === 0) lines.push('  No deployments recorded.');
  for (const deployment of snapshot.deployments.slice(0, 12)) {
    lines.push(`  ${short(deployment.id, 18).padEnd(18)} ${short(deployment.workflowId, 24).padEnd(24)} ${colorStatus(deployment.observedState).padEnd(20)} desired=${deployment.desiredState}`);
  }
  if (options.runId !== undefined && snapshot.events !== undefined) {
    lines.push('');
    lines.push(`${terminalPurple}TRACE ${short(options.runId)}${terminalReset} ${terminalDim}(${snapshot.events.length} events)${terminalReset}`);
    for (const event of snapshot.events.slice(-16)) lines.push(`  ${timestamp(event.timestamp)} ${short(event.type, 34).padEnd(34)} ${event.severityText === 'ERROR' ? terminalRed : terminalBlue}${event.signal}${terminalReset}`);
  }
  lines.push('');
  if (options.interactive) lines.push(`${terminalDim}Keys: r refresh · a approve first pending · d deny first pending · q quit${terminalReset}`);
  return lines.join('\n');
}

export function pendingApproval(snapshot: TerminalSnapshot): ApprovalRecord | undefined {
  return snapshot.approvals.find((approval) => approval.decision === 'pending');
}

export function portalItemCount(snapshot: TerminalSnapshot, page: TerminalPortalPage): number {
  if (page === 'home') return 9;
  if (page === 'workspace' || page === 'tree') return Math.max(1, snapshot.workflows?.length ?? 0);
  if (page === 'runs') return snapshot.runs.length;
  if (page === 'approvals') return snapshot.approvals.length;
  if (page === 'deployments') return snapshot.deployments.length;
  if (page === 'connections') return snapshot.connections?.length ?? 0;
  if (page === 'proposals') return snapshot.proposals?.length ?? 0;
  if (page === 'factory') return 1;
  if (page === 'portals') return 4;
  return 0;
}

function selectedMarker(selected: boolean): string {
  return selected ? `${terminalPurple}❯${terminalReset}` : ' ';
}

function renderPortalHeader(state: TerminalPortalState): string[] {
  return [factoryBanner(), `${terminalDim}· terminal control plane · ${state.page.toUpperCase()}${terminalReset}`, ''];
}

export function renderTerminalPortal(snapshot: TerminalSnapshot, state: TerminalPortalState, options: { clear?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.clear !== false) lines.push('\u001b[2J\u001b[H');
  lines.push(...renderPortalHeader(state));
  if (snapshot.error !== undefined) lines.push(`${terminalRed}Error:${terminalReset} ${snapshot.error}`, '');
  if (state.page === 'home') {
    lines.push(`${terminalBlue}FACTORY CONTROL PLANE${terminalReset}`, `${terminalDim}Use ↑/↓ to choose a surface, Enter to open, Esc to return.${terminalReset}`, '');
    const items: Array<[string, string]> = [
      ['Workspace', 'Files, YAML authoring, validate, plan, and run'],
      ['Tree / DAG', 'Operational workflow structure'],
      ['Runs', `${snapshot.runs.length} recorded executions`],
      ['Approvals', `${snapshot.approvals.filter((approval) => approval.decision === 'pending').length} pending decisions`],
      ['Deployments', `${snapshot.deployments.length} managed environments`],
      ['Connections', `${snapshot.connections?.length ?? 0} provider connections`],
      ['Proposals', `${snapshot.proposals?.length ?? 0} agent proposals`],
      ['Factory', 'Metrics, manifest, and runtime health'],
      ['Portals', 'Quick-launch terminal views'],
    ];
    items.forEach(([label, detail], index) => lines.push(`${selectedMarker(state.cursor === index)} ${label.padEnd(16)} ${terminalDim}${detail}${terminalReset}`));
  } else if (state.page === 'workspace') {
    lines.push(`${terminalBlue}WORKSPACE${terminalReset} ${terminalDim}· file-backed authoring${terminalReset}`, `${terminalDim}Author source in YAML, then use the commands below to validate or run it.${terminalReset}`, '');
    const workflows = snapshot.workflows ?? [];
    if (workflows.length === 0) lines.push('  No workflows loaded.');
    workflows.forEach((workflow, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(workflow.id, 26).padEnd(26)} ${short(workflow.name, 34).padEnd(34)} v${workflow.version} · ${colorStatus(workflow.status)}`));
    lines.push('', '  factory validate <project.yaml>', '  factory plan <project.yaml>', '  factory tree <project.yaml>', '  factory run <project.yaml> <workflow-id>');
  } else if (state.page === 'tree') {
    lines.push(`${terminalPurple}TREE / DAG${terminalReset} ${terminalDim}· operational workflow structure${terminalReset}`, '');
    const workflows = snapshot.workflows ?? [];
    if (workflows.length === 0) lines.push('  No workflows loaded.');
    workflows.forEach((workflow, index) => {
      lines.push(`${selectedMarker(state.cursor === index)} ${workflow.name} [${workflow.id}]`);
      workflow.nodes.forEach((node, nodeIndex) => lines.push(`    ${nodeIndex === workflow.nodes.length - 1 ? '└─' : '├─'} ${node.label} · ${node.unit?.kind ?? 'unknown'}`));
    });
  } else if (state.page === 'runs') {
    lines.push(`${terminalBlue}RUNS${terminalReset} ${terminalDim}(${snapshot.runs.length}) · Enter opens timeline${terminalReset}`, '');
    if (snapshot.runs.length === 0) lines.push('  No runs recorded.');
    snapshot.runs.forEach((run, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(run.id, 18).padEnd(18)} ${short(run.workflowName, 28).padEnd(28)} ${colorStatus(run.status)}  ${timestamp(run.startedAt)}`));
  } else if (state.page === 'approvals') {
    lines.push(`${terminalYellow}APPROVALS${terminalReset} ${terminalDim}(${snapshot.approvals.length}) · a approve · d deny${terminalReset}`, '');
    if (snapshot.approvals.length === 0) lines.push('  No approvals recorded.');
    snapshot.approvals.forEach((approval, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(approval.id, 18).padEnd(18)} run ${short(approval.runId, 18).padEnd(18)} ${short(approval.operation, 20).padEnd(20)} ${colorStatus(approval.decision)}`));
  } else if (state.page === 'deployments') {
    lines.push(`${terminalBlue}DEPLOYMENTS${terminalReset} ${terminalDim}(${snapshot.deployments.length}) · managed operational state${terminalReset}`, '');
    if (snapshot.deployments.length === 0) lines.push('  No deployments recorded.');
    snapshot.deployments.forEach((deployment, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(deployment.id, 18).padEnd(18)} ${short(deployment.workflowId, 24).padEnd(24)} ${colorStatus(deployment.observedState)}  desired=${deployment.desiredState}`));
  } else if (state.page === 'connections') {
    lines.push(`${terminalBlue}CONNECTIONS${terminalReset} ${terminalDim}· provider health and secret references${terminalReset}`, '');
    if ((snapshot.connections ?? []).length === 0) lines.push('  No connections recorded.');
    (snapshot.connections ?? []).forEach((connection, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(connection.name, 28).padEnd(28)} ${short(connection.connector, 18).padEnd(18)} ${colorStatus(connection.status)}  secret=${connection.secretConfigured ? 'configured' : 'missing'}`));
  } else if (state.page === 'proposals') {
    lines.push(`${terminalPurple}PROPOSALS${terminalReset} ${terminalDim}· bounded agent-generated changes${terminalReset}`, '');
    if ((snapshot.proposals ?? []).length === 0) lines.push('  No proposals recorded.');
    (snapshot.proposals ?? []).forEach((proposal, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(proposal.id, 20).padEnd(20)} ${short(proposal.goal, 60)}`));
  } else if (state.page === 'factory') {
    lines.push(`${terminalPurple}FACTORY${terminalReset} ${terminalDim}· runtime metrics and manifest${terminalReset}`, '');
    if (snapshot.metrics === undefined) lines.push('  Metrics unavailable.');
    else {
      lines.push(`  throughput       ${snapshot.metrics.throughput}`, `  success rate     ${snapshot.metrics.successRate}%`, `  automation       ${snapshot.metrics.automationPercent}%`, `  cost / run       $${snapshot.metrics.costPerRun}`, `  human touchpoints ${snapshot.metrics.humanTouchpoints}`);
    }
  } else if (state.page === 'portals') {
    lines.push(`${terminalPurple}PORTALS${terminalReset} ${terminalDim}· terminal quick-launch surfaces${terminalReset}`, '');
    const items: Array<[string, string]> = [
      ['Observe', 'Open the terminal runs and telemetry view'],
      ['DAG', 'Open the terminal workflow tree'],
      ['Deployments', 'Open terminal deployment operations'],
      ['Factory', 'Open terminal metrics and manifest'],
    ];
    items.forEach(([label, detail], index) => lines.push(`${selectedMarker(state.cursor === index)} ${label.padEnd(18)} ${terminalDim}${detail}${terminalReset}`));
  } else if (state.page === 'run-detail') {
    const run = snapshot.runs.find((candidate) => candidate.id === state.selectedRunId);
    lines.push(`${terminalPurple}RUN TIMELINE${terminalReset}`, '');
    if (run === undefined) lines.push(`${terminalRed}Run not found.${terminalReset}`);
    else {
      lines.push(`  ${run.workflowName} · ${colorStatus(run.status)}`, `  id=${run.id}`, `  started=${timestamp(run.startedAt)}  environment=${run.environment ?? 'local'}`, '');
      lines.push(`${terminalBlue}EVENTS${terminalReset} ${terminalDim}(${snapshot.events?.length ?? 0})${terminalReset}`);
      for (const event of (snapshot.events ?? []).slice(-20)) lines.push(`  ${timestamp(event.timestamp)} ${short(event.type, 34).padEnd(34)} ${event.signal}`);
    }
  }
  lines.push('', `${terminalDim}↑/↓ navigate · Enter select · r refresh · Esc back · q quit${terminalReset}`);
  return lines.join('\n');
}
