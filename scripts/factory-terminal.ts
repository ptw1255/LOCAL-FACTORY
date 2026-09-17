import type { AgentProposal, ApprovalRecord, ConnectionRecord, DeploymentRecord, FactoryMetrics, ProjectFileRecord, ProjectRecord, RunEvent, RunRecord, WorkflowDefinition } from '../src/domain/types.js';
import { factoryBanner } from './factory-cli.js';

export interface TerminalSnapshot {
  runs: RunRecord[];
  approvals: ApprovalRecord[];
  deployments: DeploymentRecord[];
  workflows?: WorkflowDefinition[];
  projects?: ProjectRecord[];
  projectId?: string;
  files?: ProjectFileRecord[];
  connections?: ConnectionRecord[];
  proposals?: AgentProposal[];
  metrics?: FactoryMetrics;
  events?: RunEvent[];
  error?: string;
  notice?: string;
}

export type TerminalPortalPage = 'home' | 'workspace' | 'workflow' | 'tree' | 'source-editor' | 'runs' | 'approvals' | 'deployments' | 'connections' | 'proposals' | 'factory' | 'portals' | 'run-detail';

export interface TerminalSourceEditor {
  filePath: string;
  content: string;
  originalContent: string;
  expectedSha256: string;
  cursorOffset: number;
  returnPage: 'workspace' | 'workflow' | 'tree';
}

export interface TerminalPrompt {
  label: string;
  value: string;
  defaultValue?: string;
}

export interface TerminalPortalState {
  page: TerminalPortalPage;
  cursor: number;
  selectedRunId?: string;
  editor?: TerminalSourceEditor;
  prompt?: TerminalPrompt;
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
  if (page === 'workspace') return Math.max(1, snapshot.files?.length ?? 0);
  if (page === 'workflow' || page === 'tree') return Math.max(1, snapshot.workflows?.length ?? 0);
  if (page === 'runs') return snapshot.runs.length;
  if (page === 'approvals') return snapshot.approvals.length;
  if (page === 'deployments') return snapshot.deployments.length;
  if (page === 'connections') return snapshot.connections?.length ?? 0;
  if (page === 'proposals') return snapshot.proposals?.length ?? 0;
  if (page === 'factory') return 1;
  if (page === 'portals') return 4;
  return 0;
}

export function backTerminalState(state: TerminalPortalState): TerminalPortalState {
  if (state.page === 'home') return { page: 'home', cursor: 0 };
  if (state.page === 'run-detail') return { page: 'runs', cursor: 0 };
  if (state.page === 'source-editor') return { page: state.editor?.returnPage ?? 'workspace', cursor: 0 };
  return { page: 'home', cursor: 0 };
}

function linePosition(content: string, offset: number): { line: number; column: number; lines: string[] } {
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const before = content.slice(0, safeOffset);
  const lines = content.split('\n');
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  return { line, column: safeOffset - lastNewline - 1, lines };
}

export function editTerminalSource(editor: TerminalSourceEditor, key: string): TerminalSourceEditor {
  let cursorOffset = Math.max(0, Math.min(editor.cursorOffset, editor.content.length));
  if (key === '\u001b[D') return { ...editor, cursorOffset: Math.max(0, cursorOffset - 1) };
  if (key === '\u001b[C') return { ...editor, cursorOffset: Math.min(editor.content.length, cursorOffset + 1) };
  if (key === '\u001b[H' || key === '\u0001') {
    const position = linePosition(editor.content, cursorOffset);
    return { ...editor, cursorOffset: cursorOffset - position.column };
  }
  if (key === '\u001b[F' || key === '\u0005') {
    const position = linePosition(editor.content, cursorOffset);
    return { ...editor, cursorOffset: cursorOffset + (position.lines[position.line]?.length ?? 0) - position.column };
  }
  if (key === '\u001b[A' || key === '\u001b[B') {
    const position = linePosition(editor.content, cursorOffset);
    const targetLine = Math.max(0, Math.min(position.lines.length - 1, position.line + (key === '\u001b[A' ? -1 : 1)));
    if (targetLine === position.line) return editor;
    const precedingLength = position.lines.slice(0, targetLine).reduce((total, line) => total + line.length + 1, 0);
    return { ...editor, cursorOffset: precedingLength + Math.min(position.column, position.lines[targetLine]?.length ?? 0) };
  }
  if (key === '\u007f' || key === '\b') {
    if (cursorOffset === 0) return editor;
    return { ...editor, content: `${editor.content.slice(0, cursorOffset - 1)}${editor.content.slice(cursorOffset)}`, cursorOffset: cursorOffset - 1 };
  }
  if (key === '\u001b[3~' || key === '\u0004') {
    if (cursorOffset >= editor.content.length) return editor;
    return { ...editor, content: `${editor.content.slice(0, cursorOffset)}${editor.content.slice(cursorOffset + 1)}` };
  }
  const inserted = key === '\r' || key === '\n' ? '\n' : key === '\t' ? '  ' : key.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (inserted === '' || inserted.startsWith('\u001b')) return editor;
  return { ...editor, content: `${editor.content.slice(0, cursorOffset)}${inserted}${editor.content.slice(cursorOffset)}`, cursorOffset: cursorOffset + inserted.length };
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
  if (snapshot.notice !== undefined) lines.push(`${terminalGreen}${snapshot.notice}${terminalReset}`, '');
  if (state.page === 'home') {
    lines.push(`${terminalBlue}FACTORY CONTROL PLANE${terminalReset}`, `${terminalDim}Use ↑/↓ to choose a surface, Enter to open, Esc to return.${terminalReset}`, '');
    const items: Array<[string, string]> = [
      ['Workspace', 'Edit files, validate, compile, and run'],
      ['Workflow', 'Author and inspect the executable workflow graph'],
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
    const project = snapshot.projects?.find((candidate) => candidate.id === snapshot.projectId);
    lines.push(
      `${terminalBlue}WORKSPACE${terminalReset} ${terminalDim}· file-backed authoring${terminalReset}`,
      `  active  ${project?.name ?? 'No workspace selected'} ${terminalDim}${snapshot.projectId ?? ''}${terminalReset}`,
      `${terminalDim}Select a resource file and press Enter or e to edit it in the terminal.${terminalReset}`,
      '',
    );
    const files = snapshot.files ?? [];
    if (files.length === 0) lines.push('  No project files loaded.');
    files.forEach((file, index) => lines.push(`${selectedMarker(state.cursor === index)} ${short(file.path, 64).padEnd(64)} ${terminalDim}${short(file.sha256, 12)}${terminalReset}`));
    lines.push('', `${terminalDim}n new workspace · s switch workspace · w new workflow · v validate/compile${terminalReset}`, '  Save → compile → artifact is the authoring lifecycle.');
  } else if (state.page === 'workflow' || state.page === 'tree') {
    const project = snapshot.projects?.find((candidate) => candidate.id === snapshot.projectId);
    lines.push(
      `${terminalPurple}WORKFLOW${terminalReset} ${terminalDim}· authoring projection${terminalReset}`,
      `  workspace  ${project?.name ?? 'No workspace selected'}`,
      `${terminalDim}The selected graph is compiled from YAML. Enter or e opens its source envelope.${terminalReset}`,
      '',
    );
    const workflows = snapshot.workflows ?? [];
    if (workflows.length === 0) lines.push('  No workflows loaded.');
    workflows.forEach((workflow, index) => {
      lines.push(`${selectedMarker(state.cursor === index)} ${workflow.name} [${workflow.id}] v${workflow.version} · ${colorStatus(workflow.status)}`);
      if (state.cursor !== index) return;
      const outgoing = new Map<string, string[]>();
      workflow.edges.forEach((edge) => outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]));
      workflow.nodes.forEach((node, nodeIndex) => {
        const targets = outgoing.get(node.id) ?? [];
        lines.push(`    ${nodeIndex === workflow.nodes.length - 1 ? '└─' : '├─'} ${node.label} · ${node.type} · ${node.unit?.kind ?? 'unknown'}${targets.length === 0 ? '' : ` → ${targets.join(', ')}`}`);
      });
      const sourcePath = snapshot.files?.find((file) => file.path === `workflows/${workflow.id}.workflow.yaml` || file.path === `workflows/${workflow.id}.workflow.yml`)?.path;
      lines.push(sourcePath === undefined
        ? `       source: ${terminalYellow}runtime-only · Enter to materialize as YAML${terminalReset}`
        : `       source: ${sourcePath}`);
    });
    lines.push('', `${terminalDim}n new workflow · e edit source · v validate/compile · p run selected${terminalReset}`);
  } else if (state.page === 'source-editor') {
    const editor = state.editor;
    lines.push(`${terminalPurple}SOURCE EDITOR${terminalReset} ${terminalDim}· terminal-native YAML authoring${terminalReset}`, '');
    if (editor === undefined) lines.push(`${terminalRed}No source file is open.${terminalReset}`);
    else {
      const position = linePosition(editor.content, editor.cursorOffset);
      const firstLine = Math.max(0, position.line - 8);
      const lastLine = Math.min(position.lines.length, firstLine + 18);
      lines.push(`  ${editor.filePath} ${editor.content === editor.originalContent ? terminalDim + 'saved' : terminalYellow + 'modified'}${terminalReset}`, '');
      for (let index = firstLine; index < lastLine; index += 1) {
        const rawLine = (position.lines[index] ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
        const visibleLine = rawLine.length > 96 ? `${rawLine.slice(0, 95)}…` : rawLine;
        if (index === position.line) {
          const column = Math.min(position.column, visibleLine.length);
          const withCursor = `${visibleLine.slice(0, column)}${terminalPurple}▏${terminalReset}${visibleLine.slice(column)}`;
          lines.push(`${terminalPurple}>${terminalReset} ${String(index + 1).padStart(4)} │ ${withCursor}`);
        } else lines.push(`  ${String(index + 1).padStart(4)} │ ${visibleLine}`);
      }
      lines.push('', `${terminalDim}Type to edit · Ctrl+S save and compile · Esc discard changes and return${terminalReset}`);
    }
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
      ['Workflow', 'Open the terminal workflow graph'],
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
  if (state.prompt !== undefined) {
    const fallback = state.prompt.defaultValue === undefined ? '' : ` (${state.prompt.defaultValue})`;
    lines.push('', `${terminalYellow}${state.prompt.label}${fallback}:${terminalReset} ${state.prompt.value}${terminalPurple}▏${terminalReset}`, `${terminalDim}Enter accepts · Esc cancels and returns home${terminalReset}`);
  }
  const keys = state.page === 'source-editor'
    ? 'Arrows move · Ctrl+S save/compile · Esc back · Ctrl+C quit'
    : state.prompt === undefined
      ? '↑/↓ navigate · Enter select/edit · e edit source · r refresh · Esc back · q quit'
      : 'Type a value · Enter accept · Esc cancel/back';
  lines.push('', `${terminalDim}${keys}${terminalReset}`);
  return lines.join('\n');
}
