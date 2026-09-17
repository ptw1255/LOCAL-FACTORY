export type FactoryLifecycleCommand = 'launch' | 'open' | 'dashboard' | 'project' | 'author' | 'up' | 'down' | 'restart' | 'status' | 'logs' | 'build' | 'deploy' | 'observe' | 'tui' | 'approve' | 'deny' | 'cancel' | 'pause' | 'resume';
export type FactoryResourceCommand = 'validate' | 'plan' | 'workflow' | 'tree' | 'edit' | 'run';
export type FactoryCommand = FactoryLifecycleCommand | FactoryResourceCommand | 'help';

const ansiReset = '\u001b[0m';
const ansiPurple = '\u001b[35m';
const ansiBlue = '\u001b[36m';

export function factoryBanner(): string {
  const art = [
    '███████╗ █████╗  ██████╗████████╗ ██████╗ ██████╗ ██╗   ██╗',
    '██╔════╝██╔══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔══██╗╚██╗ ██╔╝',
    '█████╗  ███████║██║        ██║   ██║   ██║██████╔╝ ╚████╔╝ ',
    '██╔══╝  ██╔══██║██║        ██║   ██║   ██║██╔══██╗  ╚██╔╝  ',
    '██║     ██║  ██║╚██████╗   ██║   ╚██████╔╝██║  ██║   ██║   ',
    '╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ',
    '',
    '██╗      ██████╗  ██████╗ █████╗ ██╗     ',
    '██║     ██╔═══██╗██╔════╝██╔══██╗██║     ',
    '██║     ██║   ██║██║     ███████║██║     ',
    '██║     ██║   ██║██║     ██╔══██║██║     ',
    '███████╗╚██████╔╝╚██████╗██║  ██║███████╗',
    '╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝',
  ];
  return art.map((line, index) => `${index % 2 === 0 ? ansiPurple : ansiBlue}${line}${ansiReset}`).join('\n');
}

export interface FactoryArgs {
  command: FactoryCommand;
  authoringAction?: 'new' | 'list' | 'propose' | 'import' | 'show' | 'validate' | 'approve' | 'apply' | 'reject';
  name?: string;
  goal?: string;
  proposalId?: string;
  projectId?: string;
  resourcePath?: string;
  workflowId?: string;
  service?: string;
  runId?: string;
  reason?: string;
  follow: boolean;
  once: boolean;
  intervalMs: number;
  web: boolean;
  profiles: string[];
  help: boolean;
}

const lifecycleCommands = new Set<FactoryCommand>(['launch', 'open', 'dashboard', 'project', 'author', 'up', 'down', 'restart', 'status', 'logs', 'build', 'deploy', 'observe', 'tui', 'approve', 'deny', 'cancel', 'pause', 'resume']);
const resourceCommands = new Set<FactoryCommand>(['validate', 'plan', 'workflow', 'tree', 'edit', 'run']);
const aliases: Readonly<Record<string, FactoryCommand>> = {
  start: 'up',
  stop: 'down',
  dashboards: 'dashboard',
  watch: 'observe',
  workspace: 'project',
};

export function isLifecycleCommand(command: FactoryCommand): command is FactoryLifecycleCommand {
  return lifecycleCommands.has(command);
}

export function parseFactoryArgs(argv: readonly string[]): FactoryArgs {
  const firstArgument = argv[0]?.toLowerCase();
  const hasCommand = firstArgument !== undefined && !firstArgument.startsWith('-');
  const rawCommand = hasCommand ? firstArgument : 'launch';
  const command = aliases[rawCommand] ?? (rawCommand as FactoryCommand);
  if (command !== 'help' && !lifecycleCommands.has(command) && !resourceCommands.has(command)) {
    throw new Error(`Unknown command "${rawCommand}". Run "factory help" for usage.`);
  }
  if (command === 'help') return { command: 'help', profiles: [], follow: false, once: true, intervalMs: 2_000, web: true, help: true };
  const profiles: string[] = [];
  let resourcePath: string | undefined;
  let workflowId: string | undefined;
  let authoringAction: FactoryArgs['authoringAction'];
  let name: string | undefined;
  let goal: string | undefined;
  let proposalId: string | undefined;
  let projectId: string | undefined;
  let service: string | undefined;
  let runId: string | undefined;
  let reason: string | undefined;
  let follow = false;
  let once = false;
  let intervalMs = 2_000;
  let web = true;
  for (let index = hasCommand ? 1 : 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--help' || value === '-h') return { command: 'help', profiles, follow, once: true, intervalMs, web, help: true };
    if (value === '--no-web') { web = false; continue; }
    if (value === '--follow' || value === '-f') { follow = true; continue; }
    if (value === '--once') { once = true; continue; }
    if (value === '--interval' || value === '--interval-ms') {
      const rawInterval = argv[++index];
      const parsedInterval = Number(rawInterval);
      if (rawInterval === undefined || !Number.isFinite(parsedInterval) || parsedInterval < 250) throw new Error('--interval requires a number of at least 250 milliseconds.');
      intervalMs = Math.min(parsedInterval, 30_000);
      continue;
    }
    if (value.startsWith('--interval=')) {
      const parsedInterval = Number(value.slice('--interval='.length));
      if (!Number.isFinite(parsedInterval) || parsedInterval < 250) throw new Error('--interval requires a number of at least 250 milliseconds.');
      intervalMs = Math.min(parsedInterval, 30_000);
      continue;
    }
    if (value === '--all') {
      profiles.push('temporal', 'observability', 'ollama');
      continue;
    }
    if (value === '--profile' || value === '-p') {
      const profile = argv[++index]?.trim();
      if (profile === undefined || profile === '') throw new Error('--profile requires a value.');
      profiles.push(profile);
      continue;
    }
    if (value.startsWith('--profile=')) {
      const profile = value.slice('--profile='.length).trim();
      if (profile === '') throw new Error('--profile requires a value.');
      profiles.push(profile);
      continue;
    }
    if (value === '--project') {
      projectId = argv[++index]?.trim();
      if (projectId === undefined || projectId === '') throw new Error('--project requires a project id.');
      continue;
    }
    if (value.startsWith('--project=')) {
      projectId = value.slice('--project='.length).trim();
      if (projectId === '') throw new Error('--project requires a project id.');
      continue;
    }
    if (value.startsWith('-')) throw new Error(`Unknown option "${value}". Run "factory help" for usage.`);
    if (command === 'author' && authoringAction === undefined && ['list', 'propose', 'import', 'show', 'validate', 'approve', 'apply', 'reject'].includes(value)) authoringAction = value as Exclude<FactoryArgs['authoringAction'], 'new' | undefined>;
    else if (command === 'author' && authoringAction === 'propose' && workflowId === undefined) workflowId = value;
    else if (command === 'author' && authoringAction === 'propose') goal = goal === undefined ? value : `${goal} ${value}`;
    else if (command === 'author' && authoringAction === 'import' && resourcePath === undefined) resourcePath = value;
    else if (command === 'author' && authoringAction !== undefined && authoringAction !== 'list' && proposalId === undefined) proposalId = value;
    else if ((command === 'project' || command === 'workflow') && authoringAction === undefined && value === 'new') authoringAction = 'new';
    else if (authoringAction === 'new' && name === undefined) name = value;
    else if (authoringAction === 'new' && name !== undefined) name = `${name} ${value}`;
    else if (resourceCommands.has(command) && resourcePath === undefined) resourcePath = value;
    else if ((command === 'run' || command === 'workflow') && workflowId === undefined) workflowId = value;
    else if (command === 'logs' && service === undefined) service = value;
    else if (['observe', 'approve', 'deny', 'cancel', 'pause', 'resume'].includes(command) && runId === undefined) runId = value;
    else if ((command === 'deny' || command === 'approve') && reason === undefined) reason = value;
    else if ((command === 'deny' || command === 'approve') && reason !== undefined) reason = `${reason} ${value}`;
    else throw new Error(`Unexpected argument "${value}".`);
  }
  if (resourceCommands.has(command) && resourcePath === undefined && command !== 'workflow') throw new Error(`${command} requires a project.yaml or resource directory.`);
  if (authoringAction === 'new' && (name === undefined || name.trim() === '')) throw new Error(`${command} new requires a name.`);
  if (command === 'author' && authoringAction === undefined) authoringAction = 'list';
  if (command === 'author' && authoringAction === 'propose' && (workflowId === undefined || goal === undefined || goal.trim().length < 10)) throw new Error('author propose requires a workflow id and a goal of at least 10 characters.');
  if (command === 'author' && authoringAction === 'import' && resourcePath === undefined) throw new Error('author import requires a proposal bundle path.');
  if (command === 'author' && !['list', 'propose', 'import'].includes(authoringAction ?? '') && proposalId === undefined) throw new Error(`author ${authoringAction} requires a proposal id.`);
  if (['approve', 'deny', 'cancel', 'pause', 'resume'].includes(command) && runId === undefined) throw new Error(`${command} requires a run id.`);
  return { command, ...(authoringAction === undefined ? {} : { authoringAction }), ...(name === undefined ? {} : { name }), ...(goal === undefined ? {} : { goal }), ...(proposalId === undefined ? {} : { proposalId }), ...(projectId === undefined ? {} : { projectId }), ...(resourcePath === undefined ? {} : { resourcePath }), ...(workflowId === undefined ? {} : { workflowId }), ...(service === undefined ? {} : { service }), ...(runId === undefined ? {} : { runId }), ...(reason === undefined ? {} : { reason }), profiles: [...new Set(profiles)], follow, once, intervalMs, web, help: false };
}

export function composeArguments(action: 'up' | 'down' | 'restart' | 'ps' | 'logs' | 'build', profiles: readonly string[], service?: string): string[] {
  const profileArgs = profiles.flatMap((profile) => ['--profile', profile]);
  const actionArgs = action === 'up'
    ? ['up', '-d', '--build']
    : action === 'down'
      ? ['down', '--remove-orphans']
      : action === 'restart'
        ? ['restart']
        : action === 'build'
          ? ['build']
          : action === 'logs'
            ? ['logs', '--tail', '100', ...(service === undefined ? [] : [service])]
            : ['ps'];
  return [...profileArgs, ...actionArgs];
}

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

export function usageText(): string {
  return `${factoryBanner()}
FACTORY · terminal workflow control plane

Usage:
  factory                          Start Docker services and open the terminal monitor
  factory <command> [options]

Lifecycle:
  up | start                       Start the local stack
  down | stop                      Stop services (volumes are preserved)
  restart                          Restart services
  status                            Show service status
  logs [service]                   Tail service logs
  build                             Build the production image
  deploy                            Build and start the stack
  open                             Open the browser dashboard directly
  dashboard | dashboards           Open the terminal Portals selector
  project                          Open the active file-backed Project
  project new <name>               Create and initialize a Project
  workspace ...                    Compatibility alias for project
  observe [run-id]                 Show runs, approvals, and telemetry
  tui                              Interactive terminal monitor (q quit, a approve, d deny)
  approve <run-id> [reason]        Approve a waiting run
  deny <run-id> [reason]           Deny a waiting run
  cancel <run-id>                  Cancel a run
  pause <run-id>                   Pause a run
  resume <run-id>                  Resume a run

Authoring:
  validate <path>                  Validate a project YAML/resource directory
  plan <path>                      Print the workflow plan
  workflow                         Open terminal Workflow authoring
  workflow new <name>              Create and compile a starter workflow
  workflow <path> [workflow-id]     Inspect a local workflow resource
  author list                       List AI authoring proposals
  author propose <workflow> <goal>  Propose validated Project file changes
  author import <bundle.json>       Submit exact file changes produced by an external AI
  author show <proposal-id>         Show the semantic file diff
  author validate <proposal-id>     Revalidate against current Project files
  author approve <proposal-id>      Approve a validated proposal
  author apply <proposal-id>        Atomically apply and compile an approved proposal
  author reject <proposal-id>       Reject a proposal without changing files
  tree <path>                      Compatibility alias for workflow
  edit <path>                      Open a local resource in $EDITOR, then validate
  run <path> [workflow-id]         Execute a workflow locally

Options:
  --profile <name>                 Enable a Compose profile (repeatable)
  --project <id>                   Select a Project for API commands
  --all                            Enable temporal, observability, and ollama
  --follow                         Keep observe output live
  --once                           Render one TUI snapshot and exit
  --interval <ms>                  Poll interval (250–30000ms)
  --no-web                         Disable static dashboard serving for this stack
  --help                           Show this help

Environment:
  FACTORY_BASE_URL                 Dashboard URL (default: http://localhost:3100)
  FACTORY_API_TOKEN                Bearer token for authenticated control planes
  FACTORY_TENANT_ID                Tenant selected by terminal API commands
  FACTORY_PROJECT_ID               Project selected by terminal authoring (default: first project)
  FACTORY_ENVIRONMENT              Compile target for terminal saves (default: local)
  VISUAL / EDITOR                  Editor used only by the advanced edit command
  FACTORY_NO_OPEN=1                Print the URL without launching a browser`;
}
