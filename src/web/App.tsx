import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from './api';
import { Icon, type IconName } from './icons';
import { WorkflowNodeCard, type CanvasNode } from './WorkflowNodeCard';
import { defaultWorkUnit } from '../domain/catalog';
import { validateWorkflowInput } from '../domain/input-schema';
import type {
  AgentDefinition,
  AgentProposal,
  ApprovalRecord,
  ArtifactRecord,
  ConnectionRecord,
  FactoryMetrics,
  DeploymentRecord,
  DeploymentTransition,
  DeploymentEnvelope,
  OperationEvidence,
  NodeCatalogItem,
  ProjectRecord,
  ProjectFileRecord,
  RunEvent,
  RunRecord,
  SourceDiagnostic,
  ValidationIssue,
  ValidationResult,
  ViewId,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from './types';

const TENANT_STORAGE_KEY = 'factory.tenantId';
const PROJECT_STORAGE_KEY = 'factory.projectId';
const STUDIO_MODE_STORAGE_PREFIX = 'factory.studioMode.';
const BOTTOM_PANEL_STORAGE_PREFIX = 'factory.bottomPanel.';
const STUDIO_FILE_STORAGE_PREFIX = 'factory.studioFile.';
const STUDIO_TABS_STORAGE_PREFIX = 'factory.studioTabs.';

const nodeTypes = { workflow: WorkflowNodeCard };
const viewLabels: Record<Exclude<ViewId, 'runs'>, { label: string; icon: IconName }> = {
  // Keep the /studio route as a backwards-compatible deep link while exposing
  // the product surface as Workspace in navigation and copy.
  studio: { label: 'Workspace', icon: 'studio' },
  observe: { label: 'Observe', icon: 'runs' },
  connections: { label: 'Connections', icon: 'connections' },
  proposals: { label: 'Agent Proposals', icon: 'agent' },
  factory: { label: 'Factory', icon: 'factory' },
  deployments: { label: 'Deployments', icon: 'factory' },
};

function readView(): ViewId {
  const value = window.location.hash.replace('#/', '').split('?', 1)[0] ?? '';
  // Preserve saved links from the pre-Observe Runtime route and the newer
  // Workspace naming while keeping one canonical in-app view.
  if (value === 'runs' || value === 'runtime') return 'observe';
  if (value === 'workspace') return 'studio';
  return value in viewLabels ? (value as ViewId) : 'studio';
}

function readObserveRunId(): string | null {
  const hashQuery = window.location.hash.split('?', 2)[1];
  if (hashQuery === undefined) return null;
  const runId = new URLSearchParams(hashQuery).get('runId')?.trim();
  return runId === undefined || runId === '' ? null : runId;
}

function readStudioMode(projectId: string): 'files' | 'tree' | 'canvas' {
  const value = window.localStorage.getItem(`${STUDIO_MODE_STORAGE_PREFIX}${projectId}`);
  return value === 'tree' || value === 'canvas' ? value : 'files';
}

function readStudioFile(projectId: string): string {
  const query = window.location.hash.split('?', 2)[1];
  const fromHash = query === undefined ? null : new URLSearchParams(query).get('file');
  return fromHash?.trim() || window.sessionStorage.getItem(`${STUDIO_FILE_STORAGE_PREFIX}${projectId}`) || 'project.yaml';
}

function readStudioTabs(projectId: string): string[] {
  const active = readStudioFile(projectId);
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${STUDIO_TABS_STORAGE_PREFIX}${projectId}`) ?? 'null') as unknown;
    if (Array.isArray(stored)) {
      const paths = stored.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
      if (paths.length > 0) return paths.includes(active) ? paths : [...paths, active];
    }
  } catch {
    // Recover with the active file when older or malformed tab state exists.
  }
  return [active];
}

function readStudioLine(): number | undefined {
  const query = window.location.hash.split('?', 2)[1];
  const value = query === undefined ? undefined : Number(new URLSearchParams(query).get('line'));
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readBottomPanelState(projectId: string): { open: boolean; tab: 'problems' | 'output' } {
  const value = window.localStorage.getItem(`${BOTTOM_PANEL_STORAGE_PREFIX}${projectId}`);
  if (value === null) return { open: true, tab: 'problems' };
  try {
    const parsed = JSON.parse(value) as { open?: unknown; tab?: unknown };
    return { open: parsed.open !== false, tab: parsed.tab === 'output' ? 'output' : 'problems' };
  } catch { return { open: true, tab: 'problems' }; }
}

function formatDate(value?: string): string {
  if (value === undefined) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(value?: number): string {
  if (value === undefined) return 'In progress';
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} sec`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function formatPercent(value: number): string {
  const normalized = value <= 1 ? value * 100 : value;
  return `${normalized.toFixed(normalized >= 10 ? 0 : 1)}%`;
}

function historyFromDeploymentEvidence(items: OperationEvidence[]): DeploymentTransition[] {
  const actions = new Set<DeploymentTransition['action']>(['deploy', 'start', 'stop', 'restart', 'rollback']);
  return items
    .filter((entry) => entry.operation.startsWith('deployment.'))
    .map((entry): DeploymentTransition | undefined => {
      const action = entry.operation.slice('deployment.'.length) as DeploymentTransition['action'];
      if (!actions.has(action)) return undefined;
      const metadata = entry.metadata ?? {};
      const runId = entry.runId.startsWith('deployment:') ? undefined : entry.runId;
      return {
        id: entry.id,
        action,
        actor: entry.actor ?? 'runtime',
        occurredAt: entry.occurredAt,
        ...(typeof metadata['deployment.artifact'] === 'string' ? { toArtifactId: metadata['deployment.artifact'] } : {}),
        ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
        ...(runId === undefined ? {} : { runId }),
        ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
        outcome: entry.status === 'succeeded' ? 'succeeded' : 'failed',
        ...(entry.error === undefined ? {} : { reason: entry.error }),
      };
    })
    .filter((transition): transition is DeploymentTransition => transition !== undefined)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something unexpected happened.';
}

function groupByCategory(items: NodeCatalogItem[]): Array<[string, NodeCatalogItem[]]> {
  const groups = new Map<string, NodeCatalogItem[]>();
  for (const item of items) {
    const group = groups.get(item.category) ?? [];
    group.push(item);
    groups.set(item.category, group);
  }
  return [...groups.entries()];
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{status}</span>;
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="state-panel" role="status">
      <span className="spinner" />
      <strong>{label}</strong>
      <span>Syncing the latest data from the factory.</span>
    </div>
  );
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="state-panel error-state" role="alert">
      <Icon name="warning" size={28} />
      <strong>We couldn’t load this view</strong>
      <span>{message}</span>
      <button className="button secondary" onClick={retry} type="button">
        <Icon name="refresh" /> Try again
      </button>
    </div>
  );
}

function ProjectSwitcher({
  projects,
  currentProjectId,
  onSelect,
  onCreate,
}: {
  projects: ProjectRecord[];
  currentProjectId: string;
  onSelect: (projectId: string) => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim().length === 0) return;
    setError(null);
    try {
      await onCreate(name.trim(), description.trim());
      setName('');
      setDescription('');
      setCreating(false);
    } catch (createError) {
      setError(errorText(createError));
    }
  }

  return (
    <section className="project-switcher" aria-label="Projects">
      <span className="nav-section-label">Current loop</span>
      <select
        aria-label="Select project loop"
        onChange={(event) => onSelect(event.target.value)}
        value={currentProjectId}
      >
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <button className="project-create-button" onClick={() => setCreating((value) => !value)} type="button">
        <Icon name={creating ? 'close' : 'plus'} size={13} /> {creating ? 'Close' : 'New loop'}
      </button>
      {creating ? (
        <form className="project-create-form" onSubmit={(event) => void submit(event)}>
          <input aria-label="Loop name" autoFocus onChange={(event) => setName(event.target.value)} placeholder="Loop name" required value={name} />
          <input aria-label="Loop description" onChange={(event) => setDescription(event.target.value)} placeholder="What should it do?" value={description} />
          {error === null ? null : <small className="field-error">{error}</small>}
          <button className="button primary wide" type="submit">Create loop</button>
        </form>
      ) : null}
    </section>
  );
}

function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: IconName;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-panel empty-state">
      <span className="empty-icon"><Icon name={icon} size={26} /></span>
      <strong>{title}</strong>
      <span>{message}</span>
      {action}
    </div>
  );
}

function AppHeader({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {children === undefined ? null : <div className="header-actions">{children}</div>}
    </header>
  );
}

export function App() {
  const [view, setViewState] = useState<ViewId>(readView);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(true);
  const [scopeError, setScopeError] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      const deepLinkedRunId = readObserveRunId();
      if (deepLinkedRunId !== null) sessionStorage.setItem('selectedRunId', deepLinkedRunId);
      setViewState(readView());
    };
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const loadProjects = useCallback(async () => {
    setScopeError(null);
    try {
      const tenants = await api.tenants();
      const tenantId = window.localStorage.getItem(TENANT_STORAGE_KEY) ?? tenants.items[0]?.id ?? 'tenant-local';
      window.localStorage.setItem(TENANT_STORAGE_KEY, tenantId);
      const response = await api.projects();
      setProjects(response.items);
      const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY);
      const selected = response.items.find((project) => project.id === stored) ?? response.items[0];
      if (selected !== undefined) {
        window.localStorage.setItem(PROJECT_STORAGE_KEY, selected.id);
        setProjectId(selected.id);
      }
    } catch (loadError) {
      setScopeError(errorText(loadError));
    } finally {
      setScopeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  function selectProject(nextProjectId: string) {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, nextProjectId);
    sessionStorage.removeItem('selectedRunId');
    setProjectId(nextProjectId);
  }

  async function createProject(name: string, description: string) {
    const created = await api.createProject({ name, description });
    const source = (await api.workflows()).items[0];
    if (source !== undefined) {
      await api.cloneWorkflow(created.id, source.id, `${name} workflow`);
    }
    setProjects((current) => [...current, created]);
    selectProject(created.id);
  }

  function setView(next: ViewId) {
    window.location.hash = `/${next}`;
    setViewState(next);
    setMobileNavOpen(false);
  }

  if (scopeLoading) return <LoadingState label="Preparing your workspace" />;
  if (scopeError !== null || projectId === null) {
    return <ErrorState message={scopeError ?? 'No project is available.'} retry={() => void loadProjects()} />;
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark"><Icon name="spark" size={22} /></span>
          <div>
            <strong>Agentic</strong>
            <span>Workflow Factory</span>
          </div>
        </div>
        <ProjectSwitcher
          currentProjectId={projectId}
          onCreate={createProject}
          onSelect={selectProject}
          projects={projects}
        />
        <nav aria-label="Primary navigation">
          <span className="nav-section-label">Build & operate</span>
          {(Object.entries(viewLabels) as Array<[Exclude<ViewId, 'runs'>, (typeof viewLabels)[Exclude<ViewId, 'runs'>]]>).map(
            ([id, item]) => (
              <button
                aria-current={view === id ? 'page' : undefined}
                className={view === id ? 'active' : ''}
                key={id}
                onClick={() => setView(id)}
                type="button"
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {id === 'proposals' ? <span className="nav-beta">AI</span> : null}
              </button>
            ),
          )}
        </nav>
        <div className="sidebar-footer">
          <span className="system-dot" />
          <div>
            <strong>Factory online</strong>
            <span>Local durable engine</span>
          </div>
        </div>
      </aside>
      {mobileNavOpen ? (
        <button
          aria-label="Close navigation"
          className="nav-scrim"
          onClick={() => setMobileNavOpen(false)}
          type="button"
        />
      ) : null}
      <main className="main-content">
        <div className="mobile-bar">
          <button aria-label="Open navigation" className="icon-button" onClick={() => setMobileNavOpen(true)} type="button">
            <Icon name="menu" />
          </button>
          <div className="mobile-brand"><Icon name="spark" /> Workflow Factory</div>
          <span className="system-dot" />
        </div>
        {view === 'studio' ? <StudioView key={projectId} onNavigate={setView} projectId={projectId} /> : null}
        {view === 'observe' ? <RunsView key={projectId} /> : null}
        {view === 'connections' ? <ConnectionsView key={projectId} /> : null}
        {view === 'proposals' ? <ProposalsView key={projectId} onOpenStudio={() => setView('studio')} /> : null}
        {view === 'factory' ? <FactoryView key={projectId} onNavigate={setView} /> : null}
        {view === 'deployments' ? <DeploymentsView key={projectId} onNavigate={setView} /> : null}
      </main>
    </div>
  );
}

function workflowToCanvas(
  workflow: WorkflowDefinition,
  catalog: NodeCatalogItem[],
): { nodes: CanvasNode[]; edges: Edge[] } {
  return {
    nodes: workflow.nodes.map((node) => {
      const catalogItem = catalog.find((item) => item.type === node.type);
      return {
        id: node.id,
        type: 'workflow',
        position: node.position,
        data: {
          label: node.label,
          nodeType: node.type,
          category: catalogItem?.category ?? 'Operations',
          description: catalogItem?.description ?? 'Workflow operation',
          config: node.config,
          ...(node.sourcePath === undefined ? {} : { sourcePath: node.sourcePath }),
          ...(node.sourceLine === undefined ? {} : { sourceLine: node.sourceLine }),
          unit: node.unit,
        },
      };
    }),
    edges: workflow.edges.map((edge) => ({
      ...edge,
      type: 'smoothstep',
      animated: false,
      ...(edge.condition === undefined ? {} : { label: edge.condition }),
      style: { stroke: '#6b7f9f', strokeWidth: 1.6 },
      selected: false,
    })),
  };
}

function canvasToWorkflow(
  workflow: WorkflowDefinition,
  nodes: CanvasNode[],
  edges: Edge[],
): WorkflowDefinition {
  const workflowNodes: WorkflowNode[] = nodes.map((node) => ({
    id: node.id,
    type: node.data.nodeType,
    label: node.data.label,
    position: node.position,
    config: node.data.config,
    ...(node.data.sourcePath === undefined ? {} : { sourcePath: node.data.sourcePath }),
    ...(node.data.sourceLine === undefined ? {} : { sourceLine: node.data.sourceLine }),
    unit: node.data.unit,
  }));
  const workflowEdges: WorkflowEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === null ? {} : { sourceHandle: edge.sourceHandle }),
    ...(edge.targetHandle === null ? {} : { targetHandle: edge.targetHandle }),
    ...(typeof edge.label === 'string' && edge.label.length > 0
      ? { condition: edge.label }
      : {}),
  }));
  const trigger = workflowNodes.find((node) =>
    ['manualTrigger', 'scheduleTrigger', 'webhookTrigger'].includes(node.type),
  );
  return {
    ...workflow,
    trigger: { type: trigger?.type ?? workflow.trigger.type },
    nodes: workflowNodes,
    edges: workflowEdges,
  };
}

function StudioView({ onNavigate, projectId }: { onNavigate: (view: ViewId) => void; projectId: string }) {
  const [catalog, setCatalog] = useState<NodeCatalogItem[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [paletteSearch, setPaletteSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'save' | 'validate' | 'run' | null>(null);
  const [runMode, setRunMode] = useState<'run' | 'dry-run'>('run');
  const [runEnvironment, setRunEnvironment] = useState('local');
  const [runInputOpen, setRunInputOpen] = useState(false);
  const [runInputDraft, setRunInputDraft] = useState('{}');
  const [runInputError, setRunInputError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [configDraft, setConfigDraft] = useState('{}');
  const [configError, setConfigError] = useState<string | null>(null);
  const [unitDraft, setUnitDraft] = useState('{}');
  const [unitError, setUnitError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [agentDraft, setAgentDraft] = useState('[]');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(() => window.localStorage.getItem(`factory.onboarding.${projectId}.run`) === 'true');
  const [hintDismissed, setHintDismissed] = useState(() => window.localStorage.getItem(`factory.onboarding.${projectId}.dismissed`) === 'true');
  const [yamlSource, setYamlSource] = useState('');
  const [yamlDirty, setYamlDirty] = useState(false);
  const sourceSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const [studioMode, setStudioMode] = useState<'files' | 'tree' | 'canvas'>(() => readStudioMode(projectId));

  async function hydrateCanvasProjection(candidate: WorkflowDefinition): Promise<WorkflowDefinition> {
    try {
      const file = await api.projectFile(projectId, `canvas/${candidate.id}.canvas.yaml`);
      if (file.content === undefined) return candidate;
      const { applyCanvasResource } = await import('../declarative/migration');
      return applyCanvasResource(candidate, file.content);
    } catch {
      // Canvas files are a compatibility projection; a missing or unavailable
      // projection must not prevent authoring the workflow source itself.
      return candidate;
    }
  }

  useEffect(() => {
    window.localStorage.setItem(`${STUDIO_MODE_STORAGE_PREFIX}${projectId}`, studioMode);
  }, [projectId, studioMode]);

  const loadStudio = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catalogResponse, workflowResponse, yamlResponse, artifactResponse] = await Promise.all([
        api.catalog(),
        api.workflows(),
        api.declarativeYaml(projectId),
        api.artifacts(projectId),
      ]);
      setCatalog(catalogResponse.items);
      setWorkflows(workflowResponse.items);
      setYamlSource(yamlResponse);
      setArtifacts(artifactResponse.items);
      setYamlDirty(false);
      const first = workflowResponse.items[0] === undefined ? null : await hydrateCanvasProjection(workflowResponse.items[0]);
      setWorkflow(first);
      if (first !== null) {
        const canvas = workflowToCanvas(first, catalogResponse.items);
        setNodes(canvas.nodes);
        setEdges(canvas.edges);
      }
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadStudio();
  }, [loadStudio]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId],
  );

  useEffect(() => {
    if (selectedNode !== null) {
      setConfigDraft(JSON.stringify(selectedNode.data.config, null, 2));
      setConfigError(null);
      setUnitDraft(JSON.stringify(selectedNode.data.unit ?? {}, null, 2));
      setUnitError(null);
    }
  }, [selectedNode?.id]);

  const filteredCatalog = useMemo(() => {
    const search = paletteSearch.trim().toLowerCase();
    if (search.length === 0) return catalog;
    return catalog.filter((item) =>
      `${item.label} ${item.category} ${item.description}`.toLowerCase().includes(search),
    );
  }, [catalog, paletteSearch]);

  const markChanged = useCallback(() => {
    setDirty(true);
    setValidation(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    if (workflow !== null) {
      setAgentDraft(JSON.stringify(workflow.agents, null, 2));
      setAgentError(null);
    }
  }, [workflow?.id, workflow?.version]);

  function updateAgentDefinitions(value: string) {
    setAgentDraft(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        setAgentError('Agent definitions must be a JSON array.');
        return;
      }
      setAgentError(null);
      setWorkflow((current) => current === null ? current : { ...current, agents: parsed as AgentDefinition[] });
      markChanged();
    } catch {
      setAgentError('Enter valid JSON before saving.');
    }
  }

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      if (changes.some((change) => change.type !== 'select' && change.type !== 'dimensions')) {
        markChanged();
      }
    },
    [markChanged],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges((current) => applyEdgeChanges(changes, current));
      if (changes.some((change) => change.type !== 'select')) markChanged();
    },
    [markChanged],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
            type: 'smoothstep',
            style: { stroke: '#6b7f9f', strokeWidth: 1.6 },
          },
          current,
        ),
      );
      markChanged();
    },
    [markChanged],
  );

  function onSelectionChange(selection: OnSelectionChangeParams) {
    setSelectedNodeId(selection.nodes[0]?.id ?? null);
    setSelectedEdgeId(selection.edges[0]?.id ?? null);
  }

  async function selectWorkflow(id: string) {
    if (workflow?.id === id) return;
    setLoading(true);
    setError(null);
    try {
      const next = await hydrateCanvasProjection(await api.workflow(id));
      const canvas = workflowToCanvas(next, catalog);
      setWorkflow(next);
      setNodes(canvas.nodes);
      setEdges(canvas.edges);
      setDirty(false);
      setValidation(null);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }

  function addNode(item: NodeCatalogItem) {
    if (workflow === null) return;
    const activeWorkflow = workflow;
    const sameTypeCount = nodes.filter((node) => node.data.nodeType === item.type).length;
    const id = `${item.type}-${Date.now()}`;
    const next: CanvasNode = {
      id,
      type: 'workflow',
      position: {
        x: 260 + ((nodes.length * 36) % 480),
        y: 120 + ((nodes.length * 88) % 420),
      },
      data: {
        label: sameTypeCount === 0 ? item.label : `${item.label} ${sameTypeCount + 1}`,
        nodeType: item.type,
        category: item.category,
        description: item.description,
        config: {
          ...structuredClone(item.defaultConfig),
          ...(item.type === 'agentLoop' && activeWorkflow.agents[0] !== undefined
            ? { agentId: activeWorkflow.agents[0].id, maxIterations: activeWorkflow.agents[0].limits.maxIterations }
            : {}),
        },
        unit: defaultWorkUnit(item.type),
      },
      selected: true,
    };
    setNodes((current) => {
      const deselected: CanvasNode[] = current.map((node) => ({
        ...node,
        selected: false,
      }));
      return [...deselected, next];
    });
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    markChanged();
  }

  function updateNodeLabel(event: ChangeEvent<HTMLInputElement>) {
    const label = event.target.value;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId ? { ...node, data: { ...node.data, label } } : node,
      ),
    );
    markChanged();
  }

  function updateConfig(value: string) {
    setConfigDraft(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        setConfigError('Configuration must be a JSON object.');
        return;
      }
      setConfigError(null);
      setNodes((current) =>
        current.map((node) =>
          node.id === selectedNodeId
            ? { ...node, data: { ...node.data, config: parsed as Record<string, unknown> } }
            : node,
        ),
      );
      markChanged();
    } catch {
      setConfigError('Enter valid JSON before saving.');
    }
  }

  function updateUnit(value: string) {
    setUnitDraft(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        setUnitError('Work unit must be a JSON object.');
        return;
      }
      setUnitError(null);
      setNodes((current) => current.map((node) =>
        node.id === selectedNodeId ? { ...node, data: { ...node.data, unit: parsed as CanvasNode['data']['unit'] } } : node,
      ));
      markChanged();
    } catch {
      setUnitError('Enter valid JSON before saving.');
    }
  }

  function updateEdgeCondition(condition: string) {
    setEdges((current) =>
      current.map((edge) => (edge.id === selectedEdgeId ? { ...edge, label: condition } : edge)),
    );
    markChanged();
  }

  function removeSelection() {
    if (selectedNodeId !== null) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) =>
        current.filter(
          (edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId,
        ),
      );
      setSelectedNodeId(null);
    } else if (selectedEdgeId !== null) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
    markChanged();
  }

  async function saveWorkflow(): Promise<WorkflowDefinition | null> {
    if (workflow === null || configError !== null || unitError !== null || agentError !== null) return null;
    setBusyAction('save');
    setNotice(null);
    try {
      const saved = await api.saveWorkflow(canvasToWorkflow(workflow, nodes, edges));
      // Keep the migration/YAML serializer out of the initial IDE bundle; the
      // compatibility canvas path is loaded only when a canvas save occurs.
      const { renderCanvasResource } = await import('../declarative/migration');
      const canvasPath = `canvas/${saved.id}.canvas.yaml`;
      const currentCanvas = await api.projectFile(projectId, canvasPath).catch(() => undefined);
      await api.saveProjectFile(projectId, canvasPath, renderCanvasResource(saved), currentCanvas?.sha256);
      setWorkflow(saved);
      setYamlSource((await api.declarativeYaml(projectId)).trim());
      setYamlDirty(false);
      setWorkflows((current) =>
        current.map((item) => (item.id === saved.id ? saved : item)),
      );
      setDirty(false);
      window.localStorage.setItem(`factory.onboarding.${projectId}.saved`, 'true');
      setNotice({ tone: 'success', text: `Saved version ${saved.version}.` });
      return saved;
    } catch (saveError) {
      setNotice({ tone: 'error', text: errorText(saveError) });
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function validateWorkflow() {
    if (workflow === null) return;
    setBusyAction('validate');
    setNotice(null);
    try {
      if (dirty) {
        const saved = await saveWorkflow();
        if (saved === null) return;
      }
      if (yamlDirty) {
        const saved = sourceSaveRef.current === null ? false : await sourceSaveRef.current();
        if (!saved) {
          setNotice({ tone: 'warning', text: 'Save and compile the active source file before running.' });
          return;
        }
      }
      const result = await api.validateWorkflow(workflow.id);
      setValidation(result);
      setNotice({
        tone: result.valid ? 'success' : 'warning',
        text: result.valid
          ? 'Workflow is valid and ready to run.'
          : `Validation found ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}.`,
      });
    } catch (validationError) {
      setNotice({ tone: 'error', text: errorText(validationError) });
    } finally {
      setBusyAction(null);
    }
  }

  async function executeRun(input?: unknown) {
    if (workflow === null) return;
    setBusyAction('run');
    setNotice(null);
    try {
      if (dirty) {
        const saved = await saveWorkflow();
        if (saved === null) return;
      }
      if (yamlDirty) {
        const saved = sourceSaveRef.current === null ? false : await sourceSaveRef.current();
        if (!saved) {
          setNotice({ tone: 'warning', text: 'Save and compile the active source file before running.' });
          return;
        }
      }
      if (runMode === 'dry-run') {
        const artifact = artifacts.filter((candidate) => candidate.environment === runEnvironment && candidate.workflows.some((candidateWorkflow) => candidateWorkflow.id === workflow.id)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        const preflight = await api.dryRun(workflow.id, { environment: runEnvironment, ...(artifact === undefined ? {} : { artifactId: artifact.id }), ...(input === undefined ? {} : { input }) });
        setNotice({ tone: 'success', text: `Dry run passed for ${preflight.workflowId} v${preflight.workflowVersion}${preflight.artifactId === undefined ? '' : ` · artifact ${preflight.artifactId.slice(0, 18)}`}; no execution was started.` });
        return;
      }
      const artifact = artifacts.filter((candidate) => candidate.environment === runEnvironment && candidate.workflows.some((candidateWorkflow) => candidateWorkflow.id === workflow.id)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const run = await api.startRun(workflow.id, { environment: runEnvironment, ...(artifact === undefined ? {} : { artifactId: artifact.id }), ...(input === undefined ? {} : { input }) });
      window.localStorage.setItem(`factory.onboarding.${projectId}.run`, 'true');
      setHasRun(true);
      sessionStorage.setItem('selectedRunId', run.id);
      onNavigate('observe');
    } catch (runError) {
      setNotice({ tone: 'error', text: errorText(runError) });
    } finally {
      setBusyAction(null);
    }
  }

  async function runWorkflow() {
    if (workflow === null) return;
    if (workflow.inputSchema !== undefined && Object.keys(workflow.inputSchema).length > 0) {
      setRunInputDraft('{}');
      setRunInputError(null);
      setRunInputOpen(true);
      return;
    }
    await executeRun();
  }

  async function submitRunInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workflow === null) return;
    let input: unknown;
    try {
      input = JSON.parse(runInputDraft) as unknown;
    } catch {
      setRunInputError('Enter valid JSON.');
      return;
    }
    const validationResult = validateWorkflowInput(workflow.inputSchema, input);
    if (!validationResult.valid) {
      setRunInputError(validationResult.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setRunInputOpen(false);
    await executeRun(input);
  }

  if (loading && workflow === null) return <LoadingState label="Opening workspace" />;
  if (error !== null && workflow === null) return <ErrorState message={error} retry={() => void loadStudio()} />;
  if (workflow === null) {
    return (
      <EmptyState
        icon="studio"
        title="No workflows yet"
        message="Create a workflow through the API, then return here to design it visually."
      />
    );
  }

  return (
    <div className="studio-page">
      <div className="studio-toolbar">
        <div className="workflow-title-area">
          <button className="button primary" disabled={busyAction !== null} onClick={() => void runWorkflow()} title="Run workflow" type="button">
            <Icon name="play" size={13} /> {busyAction === 'run' ? 'Starting…' : runMode === 'dry-run' ? 'Dry run' : 'Run'}
          </button>
          <div className="breadcrumb"><span>Workflows</span><Icon name="chevron" size={13} /></div>
          <select
            aria-label="Select workflow"
            onChange={(event) => void selectWorkflow(event.target.value)}
            value={workflow.id}
          >
            {workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <StatusBadge status={workflow.status} />
          <span className="version-label">v{workflow.version}</span>
          {dirty ? <span className="dirty-indicator">Unsaved</span> : null}
        </div>
        <div className="header-actions">
          <button className="button ghost" disabled={busyAction !== null} onClick={() => void saveWorkflow()} type="button">
            <Icon name="save" /> {busyAction === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button className="button secondary" disabled={busyAction !== null} onClick={() => void validateWorkflow()} type="button">
            <Icon name="check" /> {busyAction === 'validate' ? 'Validating…' : 'Validate'}
          </button>
          <select aria-label="Run mode" className="run-mode-select" disabled={busyAction !== null} onChange={(event) => setRunMode(event.target.value as 'run' | 'dry-run')} value={runMode}>
            <option value="run">Run</option>
            <option value="dry-run">Dry run</option>
          </select>
          <select aria-label="Run environment" className="run-mode-select" disabled={busyAction !== null} onChange={(event) => setRunEnvironment(event.target.value)} value={runEnvironment}>
            <option value="local">Local</option>
            <option value="development">Development</option>
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </select>
        </div>
      </div>
      <div className="workspace-command-strip"><span><Icon name="code" size={14} /> Source is the workflow definition</span><span className="workspace-command-hint"><kbd>⌘</kbd><kbd>S</kbd> save · <kbd>⌘</kbd><kbd>↵</kbd> run</span></div>
      {hintDismissed ? (
        <button className="workspace-hint-reopen" onClick={() => { window.localStorage.removeItem(`factory.onboarding.${projectId}.dismissed`); setHintDismissed(false); }} type="button">Show workspace guide</button>
      ) : (
        <div className="workspace-hint" role="status"><span><strong>Quick start</strong> Save a file, compile it, then Run and open Observe. {hasRun ? 'This project has a completed run.' : 'No run recorded for this project yet.'}</span><button aria-label="Dismiss workspace guide" onClick={() => { window.localStorage.setItem(`factory.onboarding.${projectId}.dismissed`, 'true'); setHintDismissed(true); }} type="button"><Icon name="close" size={13} /></button></div>
      )}
      {notice !== null ? (
        <div className={`toast toast-${notice.tone}`} role="status">
          <Icon name={notice.tone === 'success' ? 'check' : 'warning'} />
          <span>{notice.text}</span>
          <button aria-label="Dismiss message" onClick={() => setNotice(null)} type="button"><Icon name="close" /></button>
        </div>
      ) : null}
      {runInputOpen ? (
        <div className="run-input-backdrop" role="presentation">
          <form aria-label="Workflow run input" className="run-input-dialog" onSubmit={(event) => void submitRunInput(event)}>
            <div className="run-input-heading"><div><span className="eyebrow">Run preflight</span><h2>Provide workflow input</h2></div><button aria-label="Close run input" className="icon-button" onClick={() => setRunInputOpen(false)} type="button"><Icon name="close" size={14} /></button></div>
            <p>Input is validated against the workflow contract before any work unit executes.</p>
            {(() => { const artifact = artifacts.filter((candidate) => candidate.environment === runEnvironment && candidate.workflows.some((candidateWorkflow) => candidateWorkflow.id === workflow.id)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]; return <p className="run-input-artifact">{artifact === undefined ? `No compiled ${runEnvironment} artifact is available; this run will use the saved workflow.` : `Pinned artifact: ${artifact.id}`}</p>; })()}
            <pre className="run-input-schema">{JSON.stringify(workflow.inputSchema, null, 2)}</pre>
            <label className="form-field"><span>Input JSON</span><textarea aria-describedby={runInputError === null ? undefined : 'run-input-error'} className={runInputError === null ? '' : 'invalid'} onChange={(event) => setRunInputDraft(event.target.value)} rows={9} spellCheck={false} value={runInputDraft} /></label>
            {runInputError === null ? null : <div className="field-error" id="run-input-error" role="alert">{runInputError}</div>}
            <div className="form-actions"><button className="button ghost" onClick={() => setRunInputOpen(false)} type="button">Cancel</button><button className="button primary" type="submit"><Icon name="play" size={13} /> {runMode === 'dry-run' ? 'Validate dry run' : 'Run workflow'}</button></div>
          </form>
        </div>
      ) : null}
      {studioMode === 'canvas' ? <div className="studio-workspace">
        <aside className="node-palette">
          <div className="panel-title">
            <div><span className="eyebrow">Components</span><h2>Node palette</h2></div>
            <span className="count-pill">{catalog.length}</span>
          </div>
          <label className="search-field">
            <span className="sr-only">Search nodes</span>
            <Icon name="search" />
            <input
              onChange={(event) => setPaletteSearch(event.target.value)}
              placeholder="Search nodes"
              type="search"
              value={paletteSearch}
            />
          </label>
          <div className="palette-list">
            {groupByCategory(filteredCatalog).map(([category, items]) => (
              <section className="palette-group" key={category}>
                <h3>{category}</h3>
                {items.map((item) => (
                  <button
                    className="palette-item"
                    key={item.type}
                    onClick={() => addNode(item)}
                    title={item.description}
                    type="button"
                  >
                    <span className={`palette-icon tone-${category.toLowerCase()}`}>
                      <Icon
                        name={
                          category === 'Triggers'
                            ? 'trigger'
                            : category === 'Data'
                              ? 'data'
                              : category === 'Agent'
                                ? 'agent'
                                : category === 'Human'
                                  ? 'human'
                                  : category === 'Connections'
                                    ? 'connections'
                                    : category === 'Control'
                                      ? 'control'
                                      : 'operations'
                        }
                      />
                    </span>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    <Icon name="plus" size={15} />
                  </button>
                ))}
              </section>
            ))}
            {filteredCatalog.length === 0 ? <p className="inline-empty">No nodes match “{paletteSearch}”.</p> : null}
          </div>
          <details className="agent-box-panel" open>
            <summary><span>Agent boxes</span><span className="count-pill">{workflow.agents.length}</span></summary>
            <p>Define the versioned purpose, skills, tools, limits, and boundaries used by agent-loop nodes.</p>
            <textarea
              aria-label="Agent definitions"
              className={agentError === null ? '' : 'invalid'}
              onChange={(event) => updateAgentDefinitions(event.target.value)}
              rows={9}
              spellCheck={false}
              value={agentDraft}
            />
            <small className={agentError === null ? '' : 'field-error'}>{agentError ?? 'JSON array · validated when saved'}</small>
          </details>
        </aside>
        <section className="flow-canvas" aria-label="Workflow canvas">
          <div className="canvas-meta">
            <span><Icon name="nodes" size={15} /> {nodes.length} nodes</span>
            <span>{edges.length} connections</span>
          </div>
          <ReactFlow
            colorMode="dark"
            deleteKeyCode={['Backspace', 'Delete']}
            edges={edges}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            nodeTypes={nodeTypes}
            nodes={nodes}
            onConnect={onConnect}
            onEdgesChange={onEdgesChange}
            onNodesChange={onNodesChange}
            onSelectionChange={onSelectionChange}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#263246" gap={24} size={1} variant={BackgroundVariant.Dots} />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              maskColor="rgba(8, 13, 22, 0.72)"
              nodeColor="#33435e"
              pannable
              position="bottom-right"
              zoomable
            />
          </ReactFlow>
        </section>
        <aside className="inspector">
          <div className="panel-title">
            <div><span className="eyebrow">Properties</span><h2>Inspector</h2></div>
            {selectedNode !== null || selectedEdge !== null ? (
              <button
                aria-label="Clear selection"
                className="icon-button"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(null);
                  setNodes((current) => current.map((node) => ({ ...node, selected: false })));
                  setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
                }}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>
          {selectedNode !== null ? (
            <div className="inspector-content">
              <div className="selected-node-summary">
                <span className={`palette-icon tone-${selectedNode.data.category.toLowerCase()}`}><Icon name="nodes" /></span>
                <div><strong>{selectedNode.data.label}</strong><span>{selectedNode.data.nodeType}</span></div>
              </div>
              <label className="form-field">
                <span>Node label</span>
                <input onChange={updateNodeLabel} value={selectedNode.data.label} />
              </label>
              <label className="form-field">
                <span>Node ID</span>
                <input disabled value={selectedNode.id} />
              </label>
              <label className="form-field">
                <span>Configuration</span>
                <textarea
                  aria-describedby={configError === null ? undefined : 'config-error'}
                  className={configError === null ? '' : 'invalid'}
                  onChange={(event) => updateConfig(event.target.value)}
                  rows={11}
                  spellCheck={false}
                  value={configDraft}
                />
                {configError === null ? <small>JSON object · changes apply as you type</small> : <small className="field-error" id="config-error">{configError}</small>}
              </label>
              <label className="form-field">
                <span>Work unit contract</span>
                <textarea
                  aria-describedby={unitError === null ? undefined : 'unit-error'}
                  className={unitError === null ? '' : 'invalid'}
                  onChange={(event) => updateUnit(event.target.value)}
                  rows={7}
                  spellCheck={false}
                  value={unitDraft}
                />
                {unitError === null ? <small>Versioned input/output, timeout, retry, and idempotency policy.</small> : <small className="field-error" id="unit-error">{unitError}</small>}
              </label>
              <button className="button danger wide" onClick={removeSelection} type="button">Remove node</button>
            </div>
          ) : selectedEdge !== null ? (
            <div className="inspector-content">
              <div className="selected-node-summary">
                <span className="palette-icon tone-control"><Icon name="connections" /></span>
                <div><strong>Connection</strong><span>{selectedEdge.source} → {selectedEdge.target}</span></div>
              </div>
              <label className="form-field">
                <span>Condition (optional)</span>
                <input
                  onChange={(event) => updateEdgeCondition(event.target.value)}
                  placeholder="e.g. approved"
                  value={typeof selectedEdge.label === 'string' ? selectedEdge.label : ''}
                />
              </label>
              <button className="button danger wide" onClick={removeSelection} type="button">Remove connection</button>
            </div>
          ) : (
            <div className="inspector-empty">
              <span><Icon name="nodes" size={24} /></span>
              <strong>Select a node</strong>
              <p>Choose a node or connection on the canvas to inspect and edit it.</p>
              <div className="keyboard-hint"><kbd>⌫</kbd><span>Delete selected</span></div>
            </div>
          )}
          {validation !== null ? (
            <div className="validation-panel">
              <h3><Icon name={validation.valid ? 'check' : 'warning'} /> Validation</h3>
              {validation.issues.length === 0 ? (
                <p className="valid-message">No issues found. This workflow is ready to run.</p>
              ) : (
                <ul>
                  {validation.issues.map((issue) => (
                    <li className={`issue-${issue.level}`} key={`${issue.code}-${issue.nodeId ?? ''}`}>
                      <strong>{issue.code}</strong><span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </aside>
      </div> : <OperationalTree
        mode={studioMode}
        onModeChange={setStudioMode}
        validation={validation}
        dirty={yamlDirty}
        onDirtyChange={setYamlDirty}
        onCanvas={() => setStudioMode('canvas')}
        onCanvasNode={(nodeId) => {
          setSelectedNodeId(nodeId);
          setSelectedEdgeId(null);
          setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })));
          setStudioMode('canvas');
        }}
        onValidate={() => void validateWorkflow()}
        onRun={() => void runWorkflow()}
        onObserve={() => onNavigate('observe')}
        onSourceChange={(value) => { setYamlSource(value); setYamlDirty(true); }}
        onSourceLoaded={(value) => { setYamlSource(value); setYamlDirty(false); }}
        onSourceImported={(nextWorkflows, source) => {
          setWorkflows(nextWorkflows);
          const next = nextWorkflows.find((item) => item.id === workflow.id) ?? nextWorkflows[0] ?? null;
          setWorkflow(next);
          if (next !== null) {
            const canvas = workflowToCanvas(next, catalog);
            setNodes(canvas.nodes);
            setEdges(canvas.edges);
          }
          setYamlSource(source);
          setYamlDirty(false);
          setDirty(false);
          setNotice({ tone: 'success', text: 'YAML applied and compiled successfully.' });
        }}
        onRegisterSave={(save) => { sourceSaveRef.current = save; }}
        projectId={projectId}
        source={yamlSource}
        workflow={workflow}
      />}
    </div>
  );
}

function OperationalTree({
  workflow,
  source,
  mode,
  validation,
  onModeChange,
  onCanvas,
  onCanvasNode,
  onValidate,
  onRun,
  onObserve,
  projectId,
  dirty,
  onDirtyChange,
  onSourceChange,
  onSourceLoaded,
  onSourceImported,
  onRegisterSave,
}: {
  workflow: WorkflowDefinition;
  source: string;
  mode: 'files' | 'tree';
  validation: ValidationResult | null;
  onModeChange: (mode: 'files' | 'tree' | 'canvas') => void;
  onCanvas: () => void;
  onCanvasNode: (nodeId: string) => void;
  onValidate: () => void;
  onRun: () => void;
  onObserve: () => void;
  projectId: string;
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSourceChange: (source: string) => void;
  onSourceLoaded: (source: string) => void;
  onSourceImported: (workflows: WorkflowDefinition[], source: string) => void;
  onRegisterSave: (save: () => Promise<boolean>) => void;
}) {
  const agentById = new Map(workflow.agents.map((agent) => [agent.id, agent]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ProjectFileRecord[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState(() => readStudioFile(projectId));
  const [openPaths, setOpenPaths] = useState<string[]>(() => readStudioTabs(projectId));
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const [fileSearch, setFileSearch] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [collapsedTreeNodes, setCollapsedTreeNodes] = useState<Set<string>>(() => new Set());
  const [treeSearch, setTreeSearch] = useState('');
  const [bottomPanelState] = useState(() => readBottomPanelState(projectId));
  const [bottomTab, setBottomTab] = useState<'problems' | 'output'>(bottomPanelState.tab);
  const [bottomOpen, setBottomOpen] = useState(bottomPanelState.open);
  const [recentRuns, setRecentRuns] = useState<RunRecord[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [problems, setProblems] = useState<SourceDiagnostic[]>([]);
  const fileEventCursor = useRef<string | undefined>(undefined);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const saveShortcutRef = useRef<() => Promise<boolean>>(async () => false);
  const formatShortcutRef = useRef<() => Promise<void>>(async () => undefined);
  const validateShortcutRef = useRef(onValidate);
  const runShortcutRef = useRef(onRun);
  const pendingProblem = useRef<SourceDiagnostic | null>(null);
  const draggedTab = useRef<string | null>(null);
  const quickOpenInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    window.localStorage.setItem(`${BOTTOM_PANEL_STORAGE_PREFIX}${projectId}`, JSON.stringify({ open: bottomOpen, tab: bottomTab }));
  }, [bottomOpen, bottomTab, projectId]);

  useEffect(() => {
    window.localStorage.setItem(`${STUDIO_TABS_STORAGE_PREFIX}${projectId}`, JSON.stringify(openPaths));
  }, [openPaths, projectId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setQuickQuery('');
        setQuickOpen(true);
      }
      if (event.key === 'Escape') setQuickOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    if (quickOpen) window.setTimeout(() => quickOpenInputRef.current?.focus(), 0);
  }, [quickOpen]);

  useEffect(() => {
    void api.projectFiles(projectId, fileSearch).then((response) => {
      setFiles(response.items);
      setDirectories((response.directories ?? []).map((directory) => directory.path));
      if (response.items.length > 0 && !response.items.some((file) => file.path === selectedPath)) {
        setSelectedPath(response.items[0]?.path ?? 'project.yaml');
      }
    }).catch(() => setFiles([]));
  }, [fileSearch, projectId]);

  useEffect(() => {
    let cancelled = false;
    const reconcileFileEvents = async (): Promise<void> => {
      try {
        const response = await api.projectFileEvents(projectId, fileEventCursor.current);
        if (cancelled || response.items.length === 0) return;
        fileEventCursor.current = response.items.at(-1)?.timestamp;
        const filesResponse = await api.projectFiles(projectId, fileSearch);
        if (cancelled) return;
        setFiles(filesResponse.items);
        setDirectories((filesResponse.directories ?? []).map((directory) => directory.path));
      } catch {
        // The regular project-file load remains the fallback when event polling
        // is unavailable (for example during an app restart).
      }
    };
    void reconcileFileEvents();
    const interval = window.setInterval(() => void reconcileFileEvents(), 2_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [fileSearch, projectId]);

  useEffect(() => {
    let cancelled = false;
    const loadRunOutput = async (): Promise<void> => {
      try {
        const response = await api.runs();
        if (cancelled) return;
        const runs = response.items.filter((run) => run.projectId === projectId).slice(0, 5);
        setRecentRuns(runs);
        const latest = runs[0];
        if (latest !== undefined) setRunEvents((await api.events(latest.id)).items.slice(-40));
      } catch {
        if (!cancelled) { setRecentRuns([]); setRunEvents([]); }
      }
    };
    void loadRunOutput();
    const interval = window.setInterval(() => void loadRunOutput(), 2_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [projectId]);

  async function selectFile(file: ProjectFileRecord) {
    if (dirty && selectedPath !== file.path && !window.confirm('Discard unsaved changes in the current file?')) return;
    setSelectedPath(file.path);
    setOpenPaths((current) => current.includes(file.path) ? current : [...current, file.path]);
    window.sessionStorage.setItem(`${STUDIO_FILE_STORAGE_PREFIX}${projectId}`, file.path);
    try {
      const loaded = await api.projectFile(projectId, file.path);
      if (loaded.content !== undefined) {
        onSourceLoaded(loaded.content);
        const sourceLine = readStudioLine();
        const problem = pendingProblem.current;
        pendingProblem.current = null;
        if (problem !== null || sourceLine !== undefined) window.setTimeout(() => {
          const line = problem?.line ?? sourceLine ?? 1;
          editorRef.current?.revealLineInCenter(line);
          editorRef.current?.setPosition({ lineNumber: line, column: problem?.column ?? 1 });
          editorRef.current?.focus();
        }, 0);
      }
    } catch (loadError) {
      setError(errorText(loadError));
    }
  }

  function openSource(path: string, line?: number): void {
    window.sessionStorage.setItem(`${STUDIO_FILE_STORAGE_PREFIX}${projectId}`, path);
    const query = new URLSearchParams({ file: path });
    if (line !== undefined && Number.isSafeInteger(line) && line > 0) query.set('line', String(line));
    window.history.replaceState(null, '', `#/studio?${query.toString()}`);
    const file = files.find((candidate) => candidate.path === path);
    if (file !== undefined) void selectFile(file);
  }

  function closeTab(filePath: string): void {
    if (filePath === selectedPath && dirty && !window.confirm('Discard unsaved changes in the current file?')) return;
    if (filePath === selectedPath && dirty) onDirtyChange(false);
    const remaining = openPaths.filter((path) => path !== filePath);
    if (remaining.length === 0) return;
    setOpenPaths(remaining);
    if (filePath === selectedPath) {
      const next = files.find((file) => file.path === remaining.at(-1));
      if (next !== undefined) void selectFile(next);
    }
  }

  function moveTab(filePath: string, direction: -1 | 1): void {
    setOpenPaths((current) => {
      const index = current.indexOf(filePath);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  }

  async function refreshFiles(): Promise<void> {
    try { setFiles((await api.projectFiles(projectId, fileSearch)).items); } catch (loadError) { setError(errorText(loadError)); }
  }

  async function createFile(): Promise<void> {
    const filePath = window.prompt('New file path', 'workflows/new.workflow.yaml')?.trim();
    if (filePath === undefined || filePath === '') return;
    try {
      const created = await api.saveProjectFile(projectId, filePath, filePath.endsWith('.json') ? '{}\n' : 'apiVersion: factory.agentic/v1\n');
      await refreshFiles();
      setSelectedPath(created.path);
      if (created.content !== undefined) onSourceLoaded(created.content);
    } catch (createError) { setError(errorText(createError)); }
  }

  async function createFolder(): Promise<void> {
    const directoryPath = window.prompt('New folder path', 'workflows')?.trim();
    if (directoryPath === undefined || directoryPath === '') return;
    try {
      await api.createProjectDirectory(projectId, directoryPath);
      await refreshFiles();
    } catch (createError) { setError(errorText(createError)); }
  }

  async function renameFile(): Promise<void> {
    const file = files.find((candidate) => candidate.path === selectedPath);
    if (file === undefined) return;
    if (dirty && !window.confirm('Rename the file with unsaved changes?')) return;
    const nextPath = window.prompt('Rename file', file.path)?.trim();
    if (nextPath === undefined || nextPath === '' || nextPath === file.path) return;
    try { await api.renameProjectFile(projectId, file.path, nextPath); await refreshFiles(); setSelectedPath(nextPath); }
    catch (renameError) { setError(errorText(renameError)); }
  }

  async function deleteFile(): Promise<void> {
    const file = files.find((candidate) => candidate.path === selectedPath);
    if (file === undefined || !window.confirm(`Move ${file.path} to workspace trash?`)) return;
    if (dirty && !window.confirm('The selected file has unsaved changes. Delete it anyway?')) return;
    try {
      const removed = await api.deleteProjectFile(projectId, file.path);
      await refreshFiles();
      const remaining = files.filter((candidate) => candidate.path !== file.path);
      const next = remaining[0]?.path ?? 'project.yaml';
      setSelectedPath(next);
      onDirtyChange(false);
      if (window.confirm(`${file.path} was moved to trash. Restore it now?`)) {
        await api.restoreProjectFile(projectId, removed.trashId);
        await refreshFiles();
        setSelectedPath(file.path);
      }
    } catch (deleteError) { setError(errorText(deleteError)); }
  }

  const visibleFiles = (files.length > 0 ? files : [{ path: 'project.yaml', sha256: '', projectId, tenantId: '', updatedAt: '' }])
    .filter((file) => !file.path.split('/').slice(0, -1).some((folder, index, folders) => collapsedFolders.has(folders.slice(0, index + 1).join('/'))));
  const folders = [...new Set(visibleFiles.flatMap((file) => file.path.split('/').slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join('/'))))];
  const treeQuery = treeSearch.trim().toLowerCase();
  const visibleTreeNodes = workflow.nodes.filter((node) => {
    if (treeQuery === '') return true;
    const agentId = node.type === 'agentLoop' && typeof node.config.agentId === 'string' ? node.config.agentId : '';
    const agent = agentById.get(agentId);
    return `${node.id} ${node.label} ${node.type} ${agent?.name ?? ''} ${agent?.purpose ?? ''}`.toLowerCase().includes(treeQuery);
  });
  const visibleTreeAgents = workflow.agents.filter((agent) => treeQuery === '' || `${agent.id} ${agent.name} ${agent.purpose} ${agent.model.model ?? agent.model.routingAlias ?? ''}`.toLowerCase().includes(treeQuery));
  const treeChildren = new Map<string, WorkflowNode[]>();
  for (const edge of workflow.edges) {
    const child = workflow.nodes.find((node) => node.id === edge.target);
    if (child === undefined) continue;
    const children = treeChildren.get(edge.source) ?? [];
    if (!children.some((candidate) => candidate.id === child.id)) children.push(child);
    treeChildren.set(edge.source, children);
  }
  const directMatches = new Set(visibleTreeNodes.map((node) => node.id));
  const includedTreeNodes = new Set<string>();
  const includeTreeNode = (node: WorkflowNode, path = new Set<string>()): boolean => {
    if (path.has(node.id)) return false;
    const nextPath = new Set(path).add(node.id);
    const includedChild = (treeChildren.get(node.id) ?? []).some((child) => includeTreeNode(child, nextPath));
    const include = directMatches.has(node.id) || includedChild;
    if (include) includedTreeNodes.add(node.id);
    return include;
  };
  workflow.nodes.forEach((node) => void includeTreeNode(node));
  const treeRoots = workflow.nodes.filter((node) => {
    if (!includedTreeNodes.has(node.id)) return false;
    const incoming = workflow.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
    return incoming.every((source) => !includedTreeNodes.has(source));
  });
  const validationByNode = new Map<string, ValidationIssue[]>(
    (validation?.issues ?? []).filter((issue): issue is ValidationIssue & { nodeId: string } => issue.nodeId !== undefined).reduce((entries, issue) => {
      const current = entries.get(issue.nodeId) ?? [];
      current.push(issue);
      entries.set(issue.nodeId, current);
      return entries;
    }, new Map<string, ValidationIssue[]>()),
  );

  async function applyYaml(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const selectedFile = files.find((file) => file.path === selectedPath);
      const isResourceFile = selectedPath === 'factory.yaml' || selectedPath.endsWith('.workflow.yaml') || selectedPath.endsWith('.agent.yaml') || selectedPath.endsWith('.unit.yaml');
      if (isResourceFile) {
        await api.saveProjectFile(projectId, selectedPath, source, selectedFile?.sha256);
        const compiled = await api.compileProject(projectId);
        onSourceImported(compiled.workflows, source);
      } else {
        const response = await api.importDeclarativeYaml(projectId, source);
        onSourceImported(response.workflows, source);
      }
      setProblems([]);
      return true;
    } catch (applyError) {
      setError(errorText(applyError));
      const diagnostics = (applyError as { diagnostics?: unknown }).diagnostics;
      setProblems(Array.isArray(diagnostics) ? diagnostics as SourceDiagnostic[] : [{ severity: 'error', path: selectedPath, line: 1, column: 1, code: 'declarative.invalid', message: errorText(applyError) }]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function formatSource(): Promise<void> {
    try {
      const { parse, stringify } = await import('yaml');
      const parsed = parse(source) as unknown;
      const formatted = selectedPath.endsWith('.json')
        ? `${JSON.stringify(parsed, null, 2)}\n`
        : stringify(parsed, { indent: 2, lineWidth: 0 });
      setProblems([]);
      setError(null);
      onSourceChange(formatted);
    } catch (formatError) {
      const diagnostic: SourceDiagnostic = { severity: 'error', path: selectedPath, line: 1, column: 1, code: 'declarative.format', message: errorText(formatError) };
      setProblems([diagnostic]);
      setError(diagnostic.message);
    }
  }

  useEffect(() => {
    onRegisterSave(applyYaml);
  }, [onRegisterSave, selectedPath, source, files]);

  // Monaco registers keybindings once at mount. Keep the handlers current so
  // shortcuts operate on the latest source, validation state, and workflow.
  saveShortcutRef.current = applyYaml;
  formatShortcutRef.current = formatSource;
  validateShortcutRef.current = onValidate;
  runShortcutRef.current = onRun;

  function openProblem(problem: SourceDiagnostic): void {
    setBottomTab('problems');
    setBottomOpen(true);
    const file = files.find((candidate) => candidate.path === problem.path);
    if (file !== undefined && file.path !== selectedPath) {
      pendingProblem.current = problem;
      void selectFile(file);
    } else {
      editorRef.current?.revealLineInCenter(problem.line);
      editorRef.current?.setPosition({ lineNumber: problem.line, column: problem.column });
      editorRef.current?.focus();
    }
  }

  const visibleProblems = problems.length === 0 && error !== null
    ? [{ severity: 'error' as const, path: selectedPath, line: 1, column: 1, code: 'declarative.invalid', message: error }]
    : problems;
  const quickMatches = files.filter((file) => file.path.toLowerCase().includes(quickQuery.trim().toLowerCase())).slice(0, 20);

  function renderTreeNode(node: WorkflowNode, depth: number, ancestry = new Set<string>()): ReactNode {
    const agentId = node.type === 'agentLoop' && typeof node.config.agentId === 'string' ? node.config.agentId : undefined;
    const agent = agentId === undefined ? undefined : agentById.get(agentId);
    const sourcePath = node.sourcePath ?? (agent === undefined
      ? files.find((file) => file.path.includes(workflow.id) && file.path.includes('.workflow.'))?.path
      : files.find((file) => file.path.includes(agent.id) && file.path.includes('.agent.'))?.path);
    const sourceFile = sourcePath === undefined ? undefined : files.find((file) => file.path === sourcePath);
    const nodeIssues = validationByNode.get(node.id) ?? [];
    const highestIssue = nodeIssues.some((issue) => issue.level === 'error') ? 'error' : nodeIssues.length > 0 ? 'warning' : undefined;
    const descendants = (treeChildren.get(node.id) ?? []).filter((child) => includedTreeNodes.has(child.id) && !ancestry.has(child.id));
    const expanded = !collapsedTreeNodes.has(node.id);
    const nextAncestry = new Set(ancestry).add(node.id);
    return (
      <li key={`${node.id}-${depth}`} className="tree-entry" style={{ marginLeft: `${depth * 12}px` }}>
        <span className={`tree-rail ${descendants.length === 0 ? 'last' : ''}`} />
        <span className={`tree-icon tree-kind-${node.unit?.kind ?? 'deterministic'}`}><Icon name={node.type === 'agentLoop' ? 'agent' : node.type === 'approval' ? 'human' : 'code'} size={14} /></span>
        <div className="tree-node-row">
          {descendants.length === 0 ? <span className="tree-expand-spacer" /> : <button aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.label}`} aria-expanded={expanded} className="icon-button tree-expand-toggle" onClick={() => setCollapsedTreeNodes((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} title={expanded ? 'Collapse children' : 'Expand children'} type="button"><Icon name={expanded ? 'chevronDown' : 'chevron'} size={11} /></button>}
          <button className="tree-node" disabled={sourceFile === undefined} onClick={() => { if (sourceFile !== undefined) openSource(sourceFile.path, node.sourceLine); }} title={sourceFile === undefined ? 'No matching source file' : `Open ${sourceFile.path}${node.sourceLine === undefined ? '' : `:${node.sourceLine}`}`} type="button"><div><strong>{node.label}</strong><span className="tree-kind-label">{node.unit?.kind ?? 'work unit'}</span>{highestIssue === undefined ? null : <span className={`status-badge status-${highestIssue}`} title={nodeIssues.map((issue) => issue.message).join(' ')}>{nodeIssues.length} {highestIssue}</span>}</div><small>{node.type} · {node.unit?.timeoutMs ?? 0}ms timeout · {node.unit?.retryAttempts ?? 1} retries{node.sourceLine === undefined ? '' : ` · source line ${node.sourceLine}`}</small>{agent === undefined ? null : <div className="tree-agent"><Icon name="agent" size={12} /> {agent.name} · {agent.model.model ?? agent.model.routingAlias ?? 'unconfigured'}</div>}</button>
          <button aria-label={`Open ${node.label} on canvas`} className="icon-button tree-canvas-link" onClick={() => onCanvasNode(node.id)} title="Open on Canvas" type="button"><Icon name="studio" size={13} /></button>
        </div>
        {expanded && descendants.length > 0 ? <ol className="operational-tree tree-children">{descendants.map((child) => renderTreeNode(child, depth + 1, nextAncestry))}</ol> : null}
      </li>
    );
  }

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (monaco === null || model === null || model === undefined) return;
    monaco.editor.setModelMarkers(model, 'factory', problems
      .filter((problem) => problem.path === selectedPath)
      .map((problem) => ({
        startLineNumber: Math.max(1, problem.line),
        startColumn: Math.max(1, problem.column),
        endLineNumber: Math.max(1, problem.line),
        endColumn: Math.max(2, problem.column + 1),
        message: problem.message,
        code: problem.code,
        severity: problem.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      })));
    return () => { monaco.editor.setModelMarkers(model, 'factory', []); };
  }, [problems, selectedPath]);

  return (
    <div className={`ide-layout ide-mode-${mode}`}>
      <aside className="ide-explorer">
        <div className="ide-explorer-title"><span className="eyebrow">Explorer</span><span className="ide-explorer-actions"><button aria-label="New file" className="icon-button" onClick={() => void createFile()} title="New file" type="button"><Icon name="plus" size={13} /></button><button aria-label="New folder" className="icon-button" onClick={() => void createFolder()} title="New folder" type="button"><Icon name="folder" size={13} /></button><button aria-label="Rename selected file" className="icon-button" disabled={!files.some((file) => file.path === selectedPath)} onClick={() => void renameFile()} title="Rename selected file" type="button"><Icon name="edit" size={13} /></button><button aria-label="Delete selected file" className="icon-button" disabled={!files.some((file) => file.path === selectedPath)} onClick={() => void deleteFile()} title="Delete selected file" type="button"><Icon name="trash" size={13} /></button></span></div>
        <label className="ide-view-selector"><span>View</span><select aria-label="Workspace view" onChange={(event) => onModeChange(event.target.value as 'files' | 'tree' | 'canvas')} value={mode}><option value="files">Files</option><option value="tree">Tree</option><option value="canvas">Canvas</option></select></label>
        <label className="ide-file-search"><span className="sr-only">Filter files</span><input onChange={(event) => setFileSearch(event.target.value)} placeholder="Filter files" type="search" value={fileSearch} /></label>
        <div className="ide-project"><Icon name="factory" size={15} /><strong>{workflow.projectId ?? 'project'}</strong></div>
        {[...new Set([...folders, ...directories])].sort().map((folder) => <button className="ide-folder" key={folder} onClick={() => setCollapsedFolders((current) => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next; })} type="button"><Icon name={collapsedFolders.has(folder) ? 'chevron' : 'chevronDown'} size={12} /> {folder}</button>)}
        {visibleFiles.map((file) => <button className={`ide-file ${selectedPath === file.path ? 'active' : ''}`} key={file.path} onClick={() => void selectFile(file)} type="button"><Icon name={file.path.includes('agent') ? 'agent' : 'code'} size={14} /> <span>{file.path}</span>{selectedPath === file.path && dirty ? <span className="ide-tab-dot" title="Unsaved changes" /> : null}</button>)}
        {files.length === 0 ? workflow.agents.map((agent) => <div className="ide-file muted" key={agent.id}><Icon name="agent" size={14} /> agents/{agent.id}.agent.yaml</div>) : null}
        <div className="ide-folder"><Icon name="chevron" size={12} /> runtime</div>
        <div className="ide-file muted"><Icon name="runs" size={14} /> runs</div>
        <div className="ide-file muted"><Icon name="operations" size={14} /> telemetry</div>
        <div className="ide-explorer-footer"><span className="system-dot" /> Git-backed definition</div>
      </aside>
      <section className="yaml-panel ide-editor">
        <div className="ide-tab-bar"><div className="ide-tabs" role="tablist" aria-label="Open files">{openPaths.map((filePath) => <span className={`ide-tab ${selectedPath === filePath ? 'active' : ''}`} draggable key={filePath} onDragEnd={() => { draggedTab.current = null; }} onDragOver={(event) => event.preventDefault()} onDragStart={() => { draggedTab.current = filePath; }} onDrop={() => { const source = draggedTab.current; draggedTab.current = null; if (source === null || source === filePath) return; setOpenPaths((current) => { const from = current.indexOf(source); const to = current.indexOf(filePath); if (from < 0 || to < 0) return current; const next = [...current]; next.splice(from, 1); next.splice(to, 0, source); return next; }); }}><button aria-selected={selectedPath === filePath} onClick={() => { const file = files.find((candidate) => candidate.path === filePath); if (file !== undefined) void selectFile(file); }} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); moveTab(filePath, event.key === 'ArrowLeft' ? -1 : 1); } }} role="tab" type="button"><Icon name={filePath.includes('agent') ? 'agent' : 'code'} size={13} /> {filePath}{selectedPath === filePath && dirty ? <span className="ide-tab-dot" title="Unsaved changes" /> : null}</button>{openPaths.length > 1 ? <button aria-label={`Close ${filePath}`} className="ide-tab-close" onClick={() => closeTab(filePath)} type="button">×</button> : null}</span>)}</div><span className="ide-branch">factory.agentic/v1</span></div>
        <div className="ide-editor-heading"><div><span className="eyebrow">Declarative source</span><h2>Project definition</h2><p>Author the loop in YAML. Apply compiles it into the runtime model.</p></div><div className="ide-editor-actions"><span className={dirty ? 'ide-dirty' : 'ide-clean'}>{dirty ? 'Unsaved changes' : 'Synced'}</span><button className="button ghost" onClick={() => void formatSource()} type="button"><Icon name="code" size={14} /> Format</button><button className="button primary" disabled={!dirty || busy} onClick={() => void applyYaml()} type="button"><Icon name="save" size={14} /> {busy ? 'Applying…' : 'Apply YAML'}</button><button className="icon-button" onClick={onCanvas} title="Open canvas compatibility view" type="button"><Icon name="studio" size={15} /></button></div></div>
        <div className="yaml-editor-wrap"><Editor aria-label="Project source editor" height="100%" language={selectedPath.endsWith('.json') ? 'json' : 'yaml'} onChange={(value) => { setProblems([]); setError(null); onSourceChange(value ?? ''); }} onMount={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveShortcutRef.current(); }); editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => { void formatShortcutRef.current(); }); editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { validateShortcutRef.current(); }); editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => { runShortcutRef.current(); }); }} options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 12, tabSize: 2, wordWrap: 'on' }} theme="vs-dark" value={source} /></div>
      {error === null ? <small className="ide-hint">Review the compiled tree on the right, then apply the file when it is ready. Invalid definitions never replace the active runtime. Shortcuts: Cmd/Ctrl+S apply · Shift+Alt+F format · Cmd/Ctrl+Enter validate · Cmd/Ctrl+Shift+Enter run.</small> : <div className="ide-error"><Icon name="warning" size={14} /> {error}</div>}
        {quickOpen ? <div className="quick-open-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setQuickOpen(false); }} role="presentation"><section aria-label="Command palette" className="quick-open-dialog" role="dialog"><div className="quick-open-input"><Icon name="search" size={14} /><input aria-label="Search commands and files" autoComplete="off" onChange={(event) => setQuickQuery(event.target.value)} placeholder="Search commands or files…" ref={quickOpenInputRef} value={quickQuery} /></div><div className="quick-open-results"><div className="quick-open-heading">Commands</div>{([{ label: 'Apply source', hint: 'Save and compile active file', action: () => void applyYaml() }, { label: 'Validate workflow', hint: 'Run workflow validation', action: onValidate }, { label: 'Run workflow', hint: 'Start a workflow run', action: onRun }, { label: 'Open Observe', hint: 'Inspect runs and telemetry', action: onObserve }] as const).filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(quickQuery.trim().toLowerCase())).map((command) => <button className="quick-open-item" key={command.label} onClick={() => { setQuickOpen(false); command.action(); }} type="button"><Icon name="code" size={13} /><span><strong>{command.label}</strong><small>{command.hint}</small></span></button>)}<div className="quick-open-heading">Files</div>{quickMatches.map((file) => <button className="quick-open-item" key={file.path} onClick={() => { setQuickOpen(false); void selectFile(file); }} type="button"><Icon name={file.path.includes('agent') ? 'agent' : 'code'} size={13} /><span><strong>{file.path}</strong><small>{file.sha256 === '' ? 'Workspace file' : `Updated ${formatDate(file.updatedAt)}`}</small></span></button>)}{quickMatches.length === 0 ? <p className="inline-empty">No matching files.</p> : null}</div><div className="quick-open-footer"><span>Tab focus · Enter run · Esc close</span><kbd>⌘/Ctrl P</kbd></div></section></div> : null}
        <div className={`ide-bottom-panel ${bottomOpen ? 'open' : 'collapsed'}`}>
          <div className="ide-bottom-tabs"><button className={bottomTab === 'problems' ? 'active' : ''} onClick={() => { setBottomTab('problems'); setBottomOpen(true); }} type="button">Problems <span className={visibleProblems.length === 0 ? 'panel-count clean' : 'panel-count'}>{visibleProblems.length}</span></button><button className={bottomTab === 'output' ? 'active' : ''} onClick={() => { setBottomTab('output'); setBottomOpen(true); }} type="button">Run Output <span className="panel-count clean">{recentRuns.length}</span></button><button aria-label={bottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'} className="bottom-panel-toggle" onClick={() => setBottomOpen((value) => !value)} type="button">{bottomOpen ? '⌄' : '⌃'}</button></div>
          {bottomOpen ? <div className="ide-bottom-content">{bottomTab === 'problems' ? (visibleProblems.length === 0 ? <span>No problems detected in the current source.</span> : <ul className="ide-problems">{visibleProblems.map((problem, index) => <li key={`${problem.path}-${problem.line}-${problem.column}-${problem.code}-${index}`}><button className="ide-problem" onClick={() => openProblem(problem)} type="button"><span className="ide-problem-location">{problem.path}:{problem.line}:{problem.column}</span><span className="ide-problem-code">{problem.code}</span><span className="field-error">{problem.message}</span></button></li>)}</ul>) : <div className="ide-run-output">{recentRuns.length === 0 ? <span>No runs for this project yet.</span> : <>{recentRuns.slice(0, 1).map((run) => <div className="ide-run-summary" key={run.id}><StatusBadge status={run.status} /><span>{run.workflowName} · {formatDate(run.startedAt)}</span><button className="text-button" onClick={onObserve} type="button">Open Observe <Icon name="chevron" size={12} /></button></div>)}<ul>{runEvents.map((event) => <li key={event.id}><StatusBadge status={event.severityText ?? event.signal} /><span>{event.message}</span><time>{formatDate(event.timestamp)}</time></li>)}</ul></>}</div>}</div> : null}
        </div>
      </section>
      <section className="operational-tree-panel ide-tree-panel">
        <div className="operational-heading"><div><span className="eyebrow">Operational tree</span><h2>{workflow.name}</h2><p>{workflow.description || 'Declarative workflow definition'}</p></div><span className="status-badge status-draft">v{workflow.version}</span></div>
        <label className="ide-file-search tree-search"><span className="sr-only">Filter operational tree</span><input aria-label="Filter operational tree" onChange={(event) => setTreeSearch(event.target.value)} placeholder="Filter tree" type="search" value={treeSearch} /></label>
        <div className="tree-root"><span className="tree-icon"><Icon name="factory" size={15} /></span><div><strong>{workflow.name}</strong><small>{visibleTreeNodes.length} of {workflow.nodes.length} work units · {visibleTreeAgents.length} of {workflow.agents.length} agent boxes</small></div></div>
        <ol className="operational-tree">
          {treeRoots.map((node) => renderTreeNode(node, 0))}
        </ol>
        {visibleTreeNodes.length === 0 ? <p className="inline-empty">No matching work units.</p> : null}
        <div className="agent-boxes-heading"><span className="eyebrow">Declared boxes</span><span className="count-pill">{workflow.agents.length}</span></div>
        <div className="operational-agents">
          {visibleTreeAgents.map((agent) => (
            <button className="operational-agent" disabled={!files.some((file) => file.path.includes(agent.id) && file.path.includes('.agent.'))} key={agent.id} onClick={() => { const file = files.find((candidate) => candidate.path.includes(agent.id) && candidate.path.includes('.agent.')); if (file !== undefined) void selectFile(file); }} title={`Open source for ${agent.id}`} type="button">
              <div className="operational-agent-title"><span className="tree-icon tree-kind-agent"><Icon name="agent" size={14} /></span><div><strong>{agent.name}</strong><small>{agent.id} · v{agent.version}</small></div><span className="tree-kind-label">{agent.model.model ?? agent.model.routingAlias ?? 'unconfigured'}</span></div>
              <p>{agent.purpose}</p>
              <div className="agent-facts"><span><strong>Skills</strong>{agent.skills.length > 0 ? agent.skills.join(', ') : 'None declared'}</span><span><strong>Limits</strong>{agent.limits.maxIterations} iterations · ${agent.limits.maxCostUsd.toFixed(2)} · {Math.round(agent.limits.maxDurationMs / 1000)}s</span><span><strong>Network</strong>{agent.boundaries.network}</span></div>
            </button>
          ))}
        </div>
        {visibleTreeAgents.length === 0 ? <p className="inline-empty">No matching agent boxes.</p> : null}
      </section>
    </div>
  );
}

function RunsView() {
  type ObserveTab = 'runs' | 'logs' | 'traces' | 'metrics';
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    () => sessionStorage.getItem('selectedRunId'),
  );
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [evidence, setEvidence] = useState<OperationEvidence[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [workflowFilter, setWorkflowFilter] = useState('all');
  const [environmentFilter, setEnvironmentFilter] = useState('all');
  const [artifactFilter, setArtifactFilter] = useState('all');
  const [timeFilterHours, setTimeFilterHours] = useState(48);
  const [observeTab, setObserveTab] = useState<ObserveTab>('runs');
  const [retentionHours, setRetentionHours] = useState(48);
  const [evidenceRetentionHours, setEvidenceRetentionHours] = useState<number | null>(null);
  const [phoenixUiUrl, setPhoenixUiUrl] = useState<string | null>(null);

  const loadRuns = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const [response, health] = await Promise.all([api.runs(), api.health()]);
      const sorted = [...response.items].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
      setRuns(sorted);
      setSelectedRunId((current) => current ?? sorted[0]?.id ?? null);
      setRetentionHours(health.observability.retentionHours);
      setTimeFilterHours((current) => current === 48 ? health.observability.retentionHours : current);
      setEvidenceRetentionHours(health.observability.evidenceRetentionHours);
      setPhoenixUiUrl(health.observability.phoenixConfigured ? health.observability.phoenixUiUrl : null);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!runs.some((run) => ['queued', 'running', 'waiting'].includes(run.status))) return undefined;
    const timer = window.setInterval(() => void loadRuns(true), 5_000);
    return () => window.clearInterval(timer);
  }, [loadRuns, runs]);

  useEffect(() => {
    if (selectedRunId === null) {
      setSelectedRun(null);
      setEvents([]);
      setEvidence([]);
      setApprovals([]);
      return;
    }
    sessionStorage.setItem('selectedRunId', selectedRunId);
    setDetailLoading(true);
    Promise.all([api.run(selectedRunId), api.events(selectedRunId), api.evidence(selectedRunId), api.approvals(selectedRunId)])
      .then(([run, eventResponse, evidenceResponse, approvalResponse]) => {
        setSelectedRun(run);
        setEvents(
          [...eventResponse.items].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          ),
        );
        setEvidence([...evidenceResponse.items].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()));
        setApprovals(approvalResponse.items);
      })
      .catch((detailError: unknown) => setError(errorText(detailError)))
      .finally(() => setDetailLoading(false));
  }, [selectedRunId, runs]);

  const filteredRuns = runs.filter((run) => {
    const matchesQuery = `${run.workflowName} ${run.id}`.toLowerCase().includes(query.toLowerCase());
    const matchesWorkflow = workflowFilter === 'all' || run.workflowId === workflowFilter;
    const matchesEnvironment = environmentFilter === 'all' || run.environment === environmentFilter;
    const matchesArtifact = artifactFilter === 'all' || run.artifactId === artifactFilter;
    const matchesTime = timeFilterHours <= 0 || new Date(run.startedAt).getTime() >= Date.now() - timeFilterHours * 60 * 60 * 1000;
    return matchesQuery && matchesWorkflow && matchesEnvironment && matchesArtifact && matchesTime && (statusFilter === 'all' || run.status === statusFilter);
  });

  const environments = [...new Set(runs.map((run) => run.environment).filter((value): value is string => value !== undefined && value !== ''))].sort();
  const artifacts = [...new Set(runs.map((run) => run.artifactId).filter((value): value is string => value !== undefined && value !== ''))].sort();

  const activeRuns = runs.filter((run) => ['queued', 'running', 'waiting'].includes(run.status)).length;
  const successfulRuns = runs.filter((run) => run.status === 'succeeded').length;
  const totalCost = runs.reduce((sum, run) => sum + run.costUsd, 0);
  const visibleEvents = observeTab === 'runs'
    ? events
    : events.filter((event) => event.signal === (observeTab === 'logs' ? 'log' : observeTab === 'traces' ? 'trace' : 'metric'));
  const eventBySpanId = new Map(events.map((event) => [event.spanId, event]));
  const eventDepth = new Map<string, number>();
  const depthFor = (event: RunEvent, seen = new Set<string>()): number => {
    const cached = eventDepth.get(event.id);
    if (cached !== undefined) return cached;
    if (event.parentSpanId === undefined || seen.has(event.parentSpanId)) {
      eventDepth.set(event.id, 0);
      return 0;
    }
    seen.add(event.parentSpanId);
    const parent = eventBySpanId.get(event.parentSpanId);
    const depth = parent === undefined ? 0 : Math.min(6, depthFor(parent, seen) + 1);
    eventDepth.set(event.id, depth);
    return depth;
  };
  events.forEach((event) => depthFor(event));

  function openSource(path: string, line?: number): void {
    const projectId = selectedRun?.projectId ?? window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? '';
    if (projectId !== '') window.sessionStorage.setItem(`${STUDIO_FILE_STORAGE_PREFIX}${projectId}`, path);
    const query = new URLSearchParams({ file: path, ...(line === undefined ? {} : { line: String(line) }) });
    window.location.hash = `/studio?${query.toString()}`;
  }

  async function runAction(action: 'approve' | 'deny' | 'expire' | 'supersede' | 'cancel' | 'pause' | 'resume' | 'retry') {
    if (selectedRun === null) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const updated =
        action === 'approve'
          ? await api.approveRun(selectedRun.id)
          : action === 'deny'
            ? await api.denyRun(selectedRun.id)
            : action === 'expire'
              ? await api.expireRun(selectedRun.id)
              : action === 'supersede'
                ? await api.supersedeRun(selectedRun.id)
              : action === 'cancel'
                ? await api.cancelRun(selectedRun.id)
                : action === 'pause'
                  ? await api.pauseRun(selectedRun.id)
                  : action === 'resume'
                    ? await api.resumeRun(selectedRun.id)
                : await api.retryRun(selectedRun.id, `${selectedRun.id}:observe-retry`);
      setSelectedRun(updated);
      if (action === 'retry') setSelectedRunId(updated.id);
      await loadRuns(true);
    } catch (actionFailure) {
      setActionError(errorText(actionFailure));
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="page">
      <AppHeader eyebrow="Observability" title="Observe">
        <button className="button secondary" onClick={() => void loadRuns()} type="button"><Icon name="refresh" /> Refresh</button>
      </AppHeader>
      <section className="observe-retention" aria-label="Telemetry retention policy"><Icon name="clock" size={15} /><span><strong>Telemetry retention:</strong> {retentionHours} hours. Durable operation evidence is retained {evidenceRetentionHours === null ? 'independently of telemetry policy' : `for ${evidenceRetentionHours} hours`}.</span>{phoenixUiUrl === null ? null : <a className="observe-phoenix-link" href={phoenixUiUrl} rel="noreferrer" target="_blank">Open Phoenix <Icon name="chevron" size={12} /></a>}</section>
      <section className="summary-strip">
        <div><span>All runs</span><strong>{runs.length}</strong></div>
        <div><span>Active now</span><strong>{activeRuns}</strong></div>
        <div><span>Successful</span><strong>{successfulRuns}</strong></div>
        <div><span>Total cost</span><strong>${totalCost.toFixed(3)}</strong></div>
      </section>
      {loading ? <LoadingState label="Loading run history" /> : error !== null && runs.length === 0 ? (
        <ErrorState message={error} retry={() => void loadRuns()} />
      ) : runs.length === 0 ? (
        <EmptyState icon="runs" title="No runs recorded" message="Run a workflow from Workspace to see execution events and performance here." />
      ) : (
        <div className="runs-layout">
          <section className="runs-list-panel">
            <div className="list-tools">
              <label className="search-field"><span className="sr-only">Search runs</span><Icon name="search" /><input onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" type="search" value={query} /></label>
              <select aria-label="Filter by workflow" onChange={(event) => setWorkflowFilter(event.target.value)} value={workflowFilter}>
                <option value="all">All workflows</option>
                {[...new Map(runs.map((run) => [run.workflowId, run.workflowName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select aria-label="Filter by environment" onChange={(event) => setEnvironmentFilter(event.target.value)} value={environmentFilter}>
                <option value="all">All environments</option>
                {environments.map((environment) => <option key={environment} value={environment}>{environment}</option>)}
              </select>
              <select aria-label="Filter by compiled artifact" onChange={(event) => setArtifactFilter(event.target.value)} value={artifactFilter}>
                <option value="all">All artifacts</option>
                {artifacts.map((artifact) => <option key={artifact} value={artifact}>{artifact.slice(0, 18)}</option>)}
              </select>
              <select aria-label="Filter by time window" onChange={(event) => setTimeFilterHours(Number(event.target.value))} value={timeFilterHours}>
                <option value={24}>Last 24 hours</option>
                <option value={48}>Last 48 hours</option>
                <option value={0}>All retained runs</option>
              </select>
              <select aria-label="Filter by status" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                <option value="all">All statuses</option>
                <option value="running">Running</option>
                <option value="paused">Paused</option>
                <option value="waiting">Waiting</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="timed_out">Timed out</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div className="run-list" role="list">
              {filteredRuns.map((run) => (
                <button
                  aria-pressed={run.id === selectedRunId}
                  className={`run-list-item ${run.id === selectedRunId ? 'active' : ''}`}
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  role="listitem"
                  type="button"
                >
                  <span className={`run-state-dot status-${run.status}`} />
                  <span className="run-main"><strong>{run.workflowName}</strong><small>{run.id}{run.environment === undefined ? '' : ` · ${run.environment}`}{run.artifactId === undefined ? '' : ` · ${run.artifactId.slice(0, 18)}`}</small></span>
                  <span className="run-side"><StatusBadge status={run.status} /><small>{formatDate(run.startedAt)}</small></span>
                </button>
              ))}
              {filteredRuns.length === 0 ? <p className="inline-empty">No runs match these filters.</p> : null}
            </div>
          </section>
          <section className="run-detail">
            {detailLoading ? <LoadingState label="Loading run detail" /> : selectedRun === null ? (
              <EmptyState icon="runs" title="Select a run" message="Choose a run to inspect its execution timeline." />
            ) : (
              <>
                <header className="detail-header">
                  <div><span className="eyebrow">Run {selectedRun.id}</span><h2>{selectedRun.workflowName}</h2><p>Workflow version {selectedRun.workflowVersion} · started {formatDate(selectedRun.startedAt)}</p></div>
                  <div className="run-actions">
                    <StatusBadge status={selectedRun.status} />
                    {selectedRun.status === 'waiting' ? (
                      <><button className="button primary" disabled={actionLoading} onClick={() => void runAction('approve')} type="button">
                        <Icon name="check" /> {actionLoading ? 'Updating…' : 'Approve'}
                      </button><button className="button secondary" disabled={actionLoading} onClick={() => void runAction('deny')} type="button">
                        <Icon name="close" /> {actionLoading ? 'Updating…' : 'Deny'}
                      </button><button className="button ghost" disabled={actionLoading} onClick={() => { if (window.confirm('Expire this approval?')) void runAction('expire'); }} type="button">
                        {actionLoading ? 'Updating…' : 'Expire'}
                      </button><button className="button ghost" disabled={actionLoading} onClick={() => { if (window.confirm('Request a fresh approval for this operation?')) void runAction('supersede'); }} type="button">
                        {actionLoading ? 'Updating…' : 'Fresh approval'}
                      </button></>
                    ) : null}
                    {['queued', 'running', 'waiting', 'paused'].includes(selectedRun.status) ? (
                      <button className="button secondary" disabled={actionLoading} onClick={() => void runAction('cancel')} type="button">
                        <Icon name="close" /> {actionLoading ? 'Updating…' : 'Cancel'}
                      </button>
                    ) : null}
                    {['queued', 'running'].includes(selectedRun.status) ? (
                      <button className="button ghost" disabled={actionLoading} onClick={() => void runAction('pause')} type="button">
                        {actionLoading ? 'Updating…' : 'Pause'}
                      </button>
                    ) : null}
                    {selectedRun.status === 'paused' ? (
                      <button className="button primary" disabled={actionLoading} onClick={() => void runAction('resume')} type="button">
                        <Icon name="play" /> {actionLoading ? 'Resuming…' : 'Resume'}
                      </button>
                    ) : null}
                    {['failed', 'timed_out', 'cancelled'].includes(selectedRun.status) ? (
                      <button className="button primary" disabled={actionLoading} onClick={() => { if (window.confirm('Retry this run with the same pinned workflow context?')) void runAction('retry'); }} type="button">
                        <Icon name="refresh" /> {actionLoading ? 'Retrying…' : 'Retry run'}
                      </button>
                    ) : null}
                  </div>
                </header>
                {actionError !== null ? <div className="run-error" role="alert"><Icon name="warning" /><div><strong>Action failed</strong><span>{actionError}</span></div></div> : null}
                {selectedRun.error !== undefined ? <div className="run-error" role="alert"><Icon name="warning" /><div><strong>Run failed</strong><span>{selectedRun.error}</span></div></div> : null}
                {approvals.length === 0 ? null : <section className="approval-summary"><div className="timeline-heading"><div><span className="eyebrow">Authorization</span><h3>Approval records</h3></div><span className="count-pill">{approvals.length}</span></div>{approvals.map((approval) => <div className="approval-record" key={approval.id}><strong>{approval.operation} · {approval.nodeId}</strong><StatusBadge status={approval.decision} /><span>Requested {formatDate(approval.requestedAt)} · expires {formatDate(approval.expiresAt)}</span><code>Binding {approval.bindingHash}</code>{approval.reason === undefined ? null : <small>{approval.reason}</small>}</div>)}</section>}
                <nav aria-label="Observe detail views" className="observe-tabs">
                  {(['runs', 'logs', 'traces', 'metrics'] as const).map((tab) => (
                    <button aria-selected={observeTab === tab} className={observeTab === tab ? 'active' : ''} key={tab} onClick={() => setObserveTab(tab)} role="tab" type="button">
                      {tab[0]!.toUpperCase() + tab.slice(1)}
                    </button>
                  ))}
                </nav>
                <div className="run-metrics">
                  <div><Icon name="clock" /><span>Duration</span><strong>{formatDuration(selectedRun.durationMs)}</strong></div>
                  <div><Icon name="cost" /><span>Cost</span><strong>${selectedRun.costUsd.toFixed(4)}</strong></div>
                  <div><Icon name="person" /><span>Human touches</span><strong>{selectedRun.humanTouchpoints}</strong></div>
                  <div><Icon name="success" /><span>Completed</span><strong>{formatDate(selectedRun.completedAt)}</strong></div>
                </div>
                <div className="timeline-heading"><div><span className="eyebrow">{observeTab === 'runs' ? 'Execution log' : `${observeTab[0]!.toUpperCase() + observeTab.slice(1)} signal`}</span><h3>{observeTab === 'runs' ? 'Event timeline' : `${observeTab[0]!.toUpperCase() + observeTab.slice(1)} events`}</h3></div><span className="count-pill">{visibleEvents.length} events</span></div>
                {visibleEvents.length === 0 ? (
                  <EmptyState icon="clock" title="No matching events" message="This run has not emitted events for the selected Observe view yet." />
                ) : (
                  <ol className="timeline">
                    {visibleEvents.map((event, index) => (
                      <li aria-level={(eventDepth.get(event.id) ?? 0) + 1} key={event.id} style={{ marginLeft: `${(eventDepth.get(event.id) ?? 0) * 18}px` }}>
                        <span className={`timeline-dot ${index === visibleEvents.length - 1 ? 'latest' : ''}`} />
                        <div className="timeline-card">
                          <div><strong>{event.type.replaceAll('_', ' ')}</strong><time>{formatDate(event.timestamp)}</time></div>
                          <p>{event.message}</p>
                          {event.nodeId === undefined ? null : <span className="node-reference"><Icon name="nodes" size={13} /> {event.nodeId}</span>}
                          {typeof event.attributes?.['source.path'] === 'string' ? <button className="source-link" onClick={() => openSource(String(event.attributes?.['source.path']), typeof event.attributes?.['source.line'] === 'number' ? event.attributes['source.line'] : undefined)} type="button"><Icon name="code" size={12} /> {String(event.attributes['source.path'])}{typeof event.attributes?.['source.line'] === 'number' ? `:${event.attributes['source.line']}` : ''}</button> : null}
                          {event.data === undefined || Object.keys(event.data).length === 0 ? null : <pre>{JSON.stringify(event.data, null, 2)}</pre>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {observeTab === 'runs' ? <><div className="timeline-heading"><div><span className="eyebrow">Durable evidence</span><h3>Operation history</h3></div><span className="count-pill">{evidence.length} records</span></div>
                {evidence.length === 0 ? <p className="inline-empty">No durable operation evidence recorded.</p> : (
                  <div className="stage-table evidence-table">
                    <div className="stage-row stage-head"><span>Operation</span><span>Status</span><span>Attempt</span><span>Occurred</span></div>
                    {evidence.map((entry) => <div className="stage-row" key={entry.id}><details className="evidence-detail"><summary><strong>{entry.operation} · {entry.unitId}</strong></summary><div className="evidence-detail-body">{entry.inputHash === undefined ? null : <span>Input hash: <code>{entry.inputHash}</code></span>}{entry.outputHash === undefined ? null : <span>Output hash: <code>{entry.outputHash}</code></span>}{entry.error === undefined ? null : <span className="form-error">{entry.error}</span>}{entry.metadata === undefined || Object.keys(entry.metadata).length === 0 ? null : <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>}{typeof entry.metadata?.['provider.url'] === 'string' && entry.metadata['provider.url'].startsWith('https://github.com/') ? <a href={entry.metadata['provider.url']} rel="noreferrer" target="_blank">Open provider record <Icon name="chevron" /></a> : null}</div></details><StatusBadge status={entry.status} /><span>{entry.attempt}</span><span>{formatDate(entry.occurredAt)}</span></div>)}
                  </div>
                )}</> : null}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ConnectionsView() {
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', connector: 'HTTP', environment: 'development', scopes: '', secret: '' });

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnections((await api.connections()).items);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadConnections(), [loadConnections]);

  async function submitConnection(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.createConnection({
        name: form.name.trim(),
        connector: form.connector,
        environment: form.environment.trim(),
        scopes: form.scopes.split(',').map((scope) => scope.trim()).filter(Boolean),
        ...(form.secret.length === 0 ? {} : { secret: form.secret }),
      });
      setConnections((current) => [created, ...current]);
      setForm({ name: '', connector: 'HTTP', environment: 'development', scopes: '', secret: '' });
      setShowForm(false);
    } catch (submitError) {
      setFormError(errorText(submitError));
    } finally {
      setSaving(false);
    }
  }

  const healthy = connections.filter((connection) => connection.status === 'healthy').length;

  return (
    <div className="page">
      <AppHeader eyebrow="Integration registry" title="Connections">
        <button className="button primary" onClick={() => setShowForm((current) => !current)} type="button"><Icon name={showForm ? 'close' : 'plus'} /> {showForm ? 'Close' : 'New connection'}</button>
      </AppHeader>
      <p className="page-intro">Manage integration metadata and access scopes. Credentials are encrypted and brokered by local Vault.</p>
      {showForm ? (
        <form className="connection-form" onSubmit={(event) => void submitConnection(event)}>
          <div className="form-intro"><span className="palette-icon tone-connections"><Icon name="connections" /></span><div><h2>Register connection</h2><p>Credentials are written to Vault and never stored in workflow or PostgreSQL state.</p></div></div>
          <label className="form-field"><span>Name</span><input autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Production CRM" required value={form.name} /></label>
          <label className="form-field"><span>Connector</span><select onChange={(event) => setForm({ ...form, connector: event.target.value })} value={form.connector}><option>HTTP</option><option>GitHub</option><option>Slack</option><option>PostgreSQL</option><option>Azure OpenAI</option><option>Custom</option></select></label>
          <label className="form-field"><span>Environment</span><input onChange={(event) => setForm({ ...form, environment: event.target.value })} placeholder="development" required value={form.environment} /></label>
          <label className="form-field"><span>Scopes</span><input onChange={(event) => setForm({ ...form, scopes: event.target.value })} placeholder="records:read, records:write" value={form.scopes} /><small>Comma-separated metadata only</small></label>
          <label className="form-field"><span>API key <em>(optional)</em></span><input autoComplete="off" onChange={(event) => setForm({ ...form, secret: event.target.value })} placeholder="Stored in Vault" type="password" value={form.secret} /><small>Write-only field. The key is not returned or logged.</small></label>
          {formError === null ? null : <p className="form-error" role="alert">{formError}</p>}
          <div className="form-actions"><button className="button ghost" onClick={() => setShowForm(false)} type="button">Cancel</button><button className="button primary" disabled={saving} type="submit">{saving ? 'Registering…' : 'Register connection'}</button></div>
        </form>
      ) : null}
      <section className="summary-strip connection-summary">
        <div><span>Registered</span><strong>{connections.length}</strong></div>
        <div><span>Healthy</span><strong>{healthy}</strong></div>
        <div><span>Needs attention</span><strong>{connections.length - healthy}</strong></div>
        <div><span>Total usage</span><strong>{connections.reduce((sum, item) => sum + item.usageCount, 0)}</strong></div>
      </section>
      {loading ? <LoadingState label="Loading connections" /> : error !== null ? <ErrorState message={error} retry={() => void loadConnections()} /> : connections.length === 0 ? (
        <EmptyState icon="connections" title="No connections registered" message="Add connection metadata so workflows can reference approved integrations." action={<button className="button primary" onClick={() => setShowForm(true)} type="button"><Icon name="plus" /> New connection</button>} />
      ) : (
        <div className="connection-grid">
          {connections.map((connection) => (
            <article className="connection-card" key={connection.id}>
              <header><span className="connector-logo">{connection.connector.slice(0, 2).toUpperCase()}</span><div><h2>{connection.name}</h2><span>{connection.connector}</span></div><StatusBadge status={connection.status} /></header>
              <dl><div><dt>Environment</dt><dd>{connection.environment}</dd></div><div><dt>Last checked</dt><dd>{formatDate(connection.lastCheckedAt)}</dd></div><div><dt>Usage</dt><dd>{connection.usageCount} runs</dd></div></dl>
              <div className="scope-list" aria-label="Connection scopes">{connection.scopes.length === 0 ? <span className="muted">No scopes declared</span> : connection.scopes.map((scope) => <span key={scope}>{scope}</span>)}</div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalsView({ onOpenStudio }: { onOpenStudio: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const [goal, setGoal] = useState('');
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.workflows()
      .then((response) => {
        setWorkflows(response.items);
        setWorkflowId(response.items[0]?.id ?? '');
      })
      .catch((loadError: unknown) => setError(errorText(loadError)))
      .finally(() => setLoading(false));
  }, []);

  async function generateProposal(event: FormEvent) {
    event.preventDefault();
    setGenerating(true);
    setError(null);
    try {
      setProposal(await api.createProposal(goal.trim(), workflowId));
    } catch (proposalError) {
      setError(errorText(proposalError));
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <LoadingState label="Preparing the agent workspace" />;

  const rationaleItems = proposal === null
    ? []
    : Array.isArray(proposal.rationale)
      ? proposal.rationale
      : [proposal.rationale];

  return (
    <div className="page proposals-page">
      <AppHeader eyebrow="AI-assisted design" title="Agent Proposals" />
      <div className="proposal-layout">
        <section className="agent-composer">
          <div className="agent-orb"><Icon name="agent" size={30} /></div>
          <span className="eyebrow">Factory design agent</span>
          <h2>What should this workflow achieve?</h2>
          <p>Describe the operational goal. The agent will propose a bounded, inspectable workflow using approved node types.</p>
          <form onSubmit={(event) => void generateProposal(event)}>
            <label className="form-field"><span>Base workflow</span><select disabled={workflows.length === 0} onChange={(event) => setWorkflowId(event.target.value)} required value={workflowId}>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name} · v{workflow.version}</option>)}</select></label>
            <label className="goal-field"><span className="sr-only">Workflow goal</span><textarea maxLength={1000} onChange={(event) => setGoal(event.target.value)} placeholder="Example: Review incoming product requests, assess risk and feasibility, route high-risk decisions for approval, then notify the requestor." required rows={7} value={goal} /><span>{goal.length}/1000</span></label>
            <button className="button primary wide" disabled={generating || workflowId.length === 0 || goal.trim().length < 8} type="submit"><Icon name="spark" /> {generating ? 'Designing proposal…' : 'Generate proposal'}</button>
          </form>
          <div className="agent-guardrails"><strong>Built-in guardrails</strong><span><Icon name="check" /> Approved catalog nodes only</span><span><Icon name="check" /> Explicit iteration and cost bounds</span><span><Icon name="check" /> Validation issues surfaced before use</span></div>
        </section>
        <section className="proposal-result" aria-live="polite">
          {generating ? <LoadingState label="Designing your workflow" /> : error !== null ? <ErrorState message={error} retry={() => setError(null)} /> : proposal === null ? (
            <EmptyState icon="agent" title="Your proposal will appear here" message="Give the design agent a clear goal to receive a workflow draft, rationale, and validation findings." />
          ) : (
            <>
              <header className="proposal-header"><div><span className="eyebrow">Proposal {proposal.id}</span><h2>{proposal.workflow.name}</h2></div><StatusBadge status={proposal.issues.some((issue) => issue.level === 'error') ? 'needs-review' : 'ready'} /></header>
              <div className="proposal-summary"><Icon name="spark" /><p>{proposal.summary}</p></div>
              <div className="proposal-flow-preview">
                {proposal.workflow.nodes.map((node, index) => (
                  <div className="proposal-step" key={node.id}>
                    <span>{index + 1}</span><div><strong>{node.label}</strong><small>{node.type}</small></div>
                    {index < proposal.workflow.nodes.length - 1 ? <Icon name="chevron" /> : null}
                  </div>
                ))}
              </div>
              <div className="proposal-columns">
                <div><h3>Why this design</h3><ol>{rationaleItems.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>
                <div><h3>Validation</h3>{proposal.issues.length === 0 ? <p className="valid-message"><Icon name="check" /> No issues detected</p> : <ul className="proposal-issues">{proposal.issues.map((issue) => <li className={`issue-${issue.level}`} key={`${issue.code}-${issue.nodeId ?? ''}`}><strong>{issue.code}</strong><span>{issue.message}</span></li>)}</ul>}</div>
              </div>
              <div className="proposal-footer"><span>{proposal.workflow.nodes.length} nodes · {proposal.workflow.edges.length} connections</span><button className="button primary" onClick={onOpenStudio} type="button">Open Workspace <Icon name="chevron" /></button></div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function DeploymentsView({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [deploymentEnvelopes, setDeploymentEnvelopes] = useState<DeploymentEnvelope[]>([]);
  const [deploymentEvidence, setDeploymentEvidence] = useState<Record<string, OperationEvidence[]>>({});
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [environmentFilter, setEnvironmentFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [healthFilter, setHealthFilter] = useState('all');
  const projectId = window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? 'project-local';
  const [form, setForm] = useState({ artifactId: '', workflowId: '', environment: 'local', trigger: 'manual' });

  function openObserveRun(runId: string): void {
    sessionStorage.setItem('selectedRunId', runId);
    onNavigate('observe');
  }

  const loadDeployments = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const [deploymentResponse, envelopeResponse, artifactResponse] = await Promise.all([api.deployments(), api.deploymentEnvelopes(), api.artifacts(projectId)]);
      setDeployments(deploymentResponse.items);
      setDeploymentEnvelopes(envelopeResponse.items);
      setArtifacts(artifactResponse.items);
      const evidenceResponses = await Promise.allSettled(deploymentResponse.items.map(async (deployment) => [deployment.id, (await api.deploymentEvidence(deployment.id)).items] as const));
      setDeploymentEvidence(Object.fromEntries(evidenceResponses.flatMap((response) => response.status === 'fulfilled' ? [response.value] : [])));
      setForm((current) => ({ ...current, artifactId: current.artifactId || artifactResponse.items[0]?.id || '', workflowId: current.workflowId || artifactResponse.items[0]?.workflows[0]?.id || '' }));
    }
    catch (loadError) { setError(errorText(loadError)); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => void loadDeployments(), [loadDeployments]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadDeployments(true), 10_000);
    return () => window.clearInterval(timer);
  }, [loadDeployments]);

  const refreshDeploymentState = useCallback(async () => {
    const current = await api.deployments();
    await Promise.allSettled(current.items.map((deployment) => api.reconcileDeployment(deployment.id)));
    const [refreshed, refreshedEnvelopes] = await Promise.all([api.deployments(), api.deploymentEnvelopes()]);
    setDeployments(refreshed.items);
    setDeploymentEnvelopes(refreshedEnvelopes.items);
    const evidenceResponses = await Promise.allSettled(refreshed.items.map(async (deployment) => [deployment.id, (await api.deploymentEvidence(deployment.id)).items] as const));
    setDeploymentEvidence(Object.fromEntries(evidenceResponses.flatMap((response) => response.status === 'fulfilled' ? [response.value] : [])));
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => { void refreshDeploymentState().catch(() => undefined); }, 5_000);
    return () => window.clearInterval(interval);
  }, [refreshDeploymentState]);

  async function act(deployment: DeploymentRecord, action: DeploymentRecord['history'][number]['action'], artifactId?: string) {
    if (['deploy', 'stop', 'restart', 'rollback'].includes(action) && !window.confirm(`Confirm ${action} for ${deployment.workflowId}?`)) return;
    setBusyId(deployment.id);
    setError(null);
    try {
      const idempotencyKey = typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${deployment.id}:${action}:${Date.now()}`;
      const updated = await api.deploymentAction(deployment.id, action, {
        ...(artifactId === undefined ? {} : { artifactId }),
        expectedUpdatedAt: deployment.updatedAt,
        idempotencyKey,
      });
      setDeployments((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (actionError) { setError(errorText(actionError)); }
    finally { setBusyId(null); }
  }

  async function createDeployment(event: FormEvent) {
    event.preventDefault();
    if (form.artifactId === '' || form.workflowId === '') {
      setFormError('Choose an artifact and workflow before creating a deployment.');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const created = await api.createDeployment(form);
      setDeployments((current) => [created, ...current]);
      setShowCreate(false);
    } catch (createError) { setFormError(errorText(createError)); }
    finally { setCreating(false); }
  }

  const selectedArtifact = artifacts.find((artifact) => artifact.id === form.artifactId);
  const artifactWorkflows = selectedArtifact?.workflows ?? [];
  const envelopeById = new Map(deploymentEnvelopes.map((envelope) => [envelope.metadata.id, envelope]));
  const operationalDeployments: DeploymentRecord[] = deployments.map((deployment): DeploymentRecord => {
    const envelope = envelopeById.get(deployment.id);
    if (envelope === undefined) return deployment;
    const evidence = deploymentEvidence[deployment.id];
    return {
      ...deployment,
      workflowId: envelope.spec.workflowId,
      environment: envelope.spec.environment,
      artifactId: envelope.spec.artifactId,
      desiredState: (envelope.spec.desiredState === 'live' ? 'running' : 'stopped') as DeploymentRecord['desiredState'],
      observedState: envelope.status.observedState,
      health: envelope.status.observedState === 'live'
        ? 'healthy'
        : ['degraded', 'failed'].includes(envelope.status.observedState)
          ? 'degraded'
          : 'unknown',
      updatedAt: envelope.status.updatedAt,
      lastError: envelope.status.error ?? undefined,
      history: evidence === undefined
        ? deployment.history
        : historyFromDeploymentEvidence(evidence),
    };
  });
  const environments = [...new Set(operationalDeployments.map((deployment) => deployment.environment))].sort();
  const filteredDeployments = operationalDeployments.filter((deployment) =>
    (environmentFilter === 'all' || deployment.environment === environmentFilter)
    && (stateFilter === 'all' || deployment.observedState === stateFilter)
    && (healthFilter === 'all' || deployment.health === healthFilter),
  );

  if (loading) return <LoadingState label="Loading deployments" />;
  if (error !== null && deployments.length === 0) return <ErrorState message={error} retry={() => void loadDeployments()} />;
  const live = operationalDeployments.filter((deployment) => deployment.observedState === 'live').length;
  const attention = operationalDeployments.filter((deployment) => ['degraded', 'failed', 'unknown'].includes(deployment.observedState)).length;

  return (
    <div className="page">
      <AppHeader eyebrow="Operational control plane" title="Deployments">
        <button className="button secondary" onClick={() => setShowCreate((current) => !current)} type="button">{showCreate ? 'Close' : 'New deployment'}</button><button className="button secondary" onClick={() => void loadDeployments()} type="button"><Icon name="refresh" /> Refresh</button>
      </AppHeader>
      <p className="page-intro">Manage which workflow versions are live in each environment. These are logical deployments backed by the local runtime, not Docker containers.</p>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      {showCreate ? <form className="deployment-create-form" onSubmit={(event) => void createDeployment(event)}>
        <div><label htmlFor="deployment-artifact">Artifact</label><select id="deployment-artifact" onChange={(event) => setForm((current) => ({ ...current, artifactId: event.target.value, workflowId: artifacts.find((artifact) => artifact.id === event.target.value)?.workflows[0]?.id ?? '' }))} value={form.artifactId}><option value="">Select compiled artifact</option>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.environment} · {artifact.id.slice(0, 18)}</option>)}</select></div>
        <div><label htmlFor="deployment-workflow">Workflow</label><select id="deployment-workflow" onChange={(event) => setForm((current) => ({ ...current, workflowId: event.target.value }))} value={form.workflowId}><option value="">Select workflow</option>{artifactWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></div>
        <div><label htmlFor="deployment-environment">Environment</label><input id="deployment-environment" onChange={(event) => setForm((current) => ({ ...current, environment: event.target.value }))} value={form.environment} /></div>
        <div><label htmlFor="deployment-trigger">Trigger</label><input id="deployment-trigger" onChange={(event) => setForm((current) => ({ ...current, trigger: event.target.value }))} value={form.trigger} /></div>
        <div className="form-actions"><button className="button primary" disabled={creating} type="submit">{creating ? 'Creating…' : 'Create deployment'}</button>{formError === null ? null : <span className="field-error">{formError}</span>}</div>
      </form> : null}
      <section className="summary-strip connection-summary">
        <div><span>Total</span><strong>{deployments.length}</strong></div>
        <div><span>Live</span><strong>{live}</strong></div>
        <div><span>Attention</span><strong>{attention}</strong></div>
        <div><span>Stopped</span><strong>{deployments.filter((deployment) => deployment.observedState === 'stopped').length}</strong></div>
      </section>
      <section className="deployment-filters" aria-label="Deployment filters">
        <label>Environment<select aria-label="Filter deployments by environment" onChange={(event) => setEnvironmentFilter(event.target.value)} value={environmentFilter}><option value="all">All environments</option>{environments.map((environment) => <option key={environment} value={environment}>{environment}</option>)}</select></label>
        <label>Observed state<select aria-label="Filter deployments by observed state" onChange={(event) => setStateFilter(event.target.value)} value={stateFilter}><option value="all">All states</option>{['live', 'starting', 'stopping', 'stopped', 'degraded', 'failed', 'unknown'].map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
        <label>Health<select aria-label="Filter deployments by health" onChange={(event) => setHealthFilter(event.target.value)} value={healthFilter}><option value="all">All health</option><option value="healthy">healthy</option><option value="degraded">degraded</option><option value="unknown">unknown</option></select></label>
        <span className="deployment-filter-count">Showing {filteredDeployments.length} of {deployments.length}</span>
      </section>
      {deployments.length === 0 ? (
        <EmptyState icon="factory" title="No deployments yet" message="Compile a workflow artifact, then create a deployment through the API to manage its desired state here." action={<button className="button primary" onClick={() => onNavigate('studio')} type="button">Open Workspace <Icon name="chevron" /></button>} />
      ) : filteredDeployments.length === 0 ? (
        <EmptyState icon="factory" title="No matching deployments" message="Adjust the environment, state, or health filters to see another deployment." />
      ) : (
        <div className="connection-grid">
          {filteredDeployments.map((deployment) => {
            const workflowName = deployment.workflowId;
            const action = deployment.observedState === 'live' ? 'stop' : 'start';
            const stale = Date.now() - Date.parse(deployment.updatedAt) > 30_000;
            const deployable = artifacts.filter((artifact) => artifact.id !== deployment.artifactId && artifact.workflows.some((workflow) => workflow.id === deployment.workflowId));
            return (
              <article className="connection-card" key={deployment.id}>
                <header><span className="connector-logo"><Icon name="factory" size={18} /></span><div><h2>{workflowName}</h2><span>{deployment.environment} · artifact {deployment.artifactId.slice(0, 18)}</span></div><div className="deployment-status"><StatusBadge status={deployment.observedState} />{stale ? <span className="stale-indicator">stale</span> : null}</div></header>
                <dl><div><dt>Desired</dt><dd>{deployment.desiredState}</dd></div><div><dt>Health</dt><dd>{deployment.health}</dd></div><div><dt>Trigger</dt><dd>{deployment.trigger} · {deployment.triggerStatus}</dd></div><div><dt>Updated</dt><dd>{formatDate(deployment.updatedAt)}</dd></div></dl>
                {deployment.lastError === undefined ? null : <p className="form-error">{deployment.lastError}</p>}
                <details className="deployment-history"><summary>Transition history ({deployment.history.length})</summary>{deployment.history.length === 0 ? <p className="inline-empty">No transitions recorded.</p> : <ul>{deployment.history.map((transition) => <li key={transition.id}><strong>{transition.action}</strong><span>{transition.outcome} · {transition.actor}</span><time>{formatDate(transition.occurredAt)}</time>{transition.reason === undefined ? null : <small>{transition.reason}</small>}{transition.runId === undefined ? null : <button className="text-button deployment-history-link" onClick={() => openObserveRun(transition.runId!)} type="button">Observe run {transition.runId} <Icon name="chevron" size={11} /></button>}</li>)}</ul>}</details>
                <div className="form-actions"><button className="button primary" disabled={busyId === deployment.id} onClick={() => void act(deployment, action)} type="button">{busyId === deployment.id ? 'Working…' : action === 'stop' ? 'Stop' : 'Start'}</button><button className="button ghost" disabled={busyId === deployment.id} onClick={() => void act(deployment, 'restart')} type="button">Restart</button>{deployable.length === 0 ? null : <select aria-label={`Deploy artifact for ${deployment.workflowId}`} defaultValue="" disabled={busyId === deployment.id} onChange={(event) => { if (event.target.value !== '') void act(deployment, 'deploy', event.target.value); }}><option value="">Deploy…</option>{deployable.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.environment} · {artifact.id.slice(0, 12)}</option>)}</select>}{(() => { const healthy = new Set(deployment.healthyArtifactIds ?? []); const prior = artifacts.filter((artifact) => artifact.id !== deployment.artifactId && healthy.has(artifact.id) && artifact.workflows.some((workflow) => workflow.id === deployment.workflowId)); return prior.length === 0 ? null : <><select aria-label={`Rollback artifact for ${deployment.workflowId}`} defaultValue="" disabled={busyId === deployment.id} onChange={(event) => { if (event.target.value !== '') void act(deployment, 'rollback', event.target.value); }}><option value="">Rollback…</option>{prior.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.environment} · {artifact.id.slice(0, 12)}</option>)}</select></>; })()}<button className="text-button" onClick={() => onNavigate('studio')} type="button">Workspace <Icon name="chevron" /></button><button className="text-button" onClick={() => onNavigate('observe')} type="button">Observe <Icon name="chevron" /></button></div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FactoryView({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const [metrics, setMetrics] = useState<FactoryMetrics | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metricResponse, runResponse] = await Promise.all([api.factoryMetrics(), api.runs()]);
      setMetrics(metricResponse);
      setRuns(runResponse.items);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadMetrics(), [loadMetrics]);

  if (loading) return <LoadingState label="Calculating factory performance" />;
  if (error !== null || metrics === null) return <ErrorState message={error ?? 'Metrics are unavailable.'} retry={() => void loadMetrics()} />;

  const maxRuns = Math.max(...metrics.stageMetrics.map((item) => item.runs), 1);
  const recentRuns = [...runs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 4);

  return (
    <div className="page factory-page">
      <AppHeader eyebrow="Executive overview" title="Factory">
        <button className="button secondary" onClick={() => void loadMetrics()} type="button"><Icon name="refresh" /> Refresh</button>
      </AppHeader>
      <section className="factory-hero">
        <div><span className="eyebrow">Operational intelligence</span><h2>Your automation factory at a glance</h2><p>Monitor throughput, efficiency, quality, and human intervention across every workflow stage.</p></div>
        <span className="live-indicator"><i /> Live metrics</span>
      </section>
      <section className="kpi-grid">
        <KpiCard icon="runs" label="Throughput" value={metrics.throughput.toLocaleString()} note="runs completed" />
        <KpiCard icon="cost" label="Cost per run" value={`$${metrics.costPerRun.toFixed(3)}`} note="average execution" />
        <KpiCard icon="spark" label="Automation" value={formatPercent(metrics.automationPercent)} note="touchless completion" />
        <KpiCard icon="person" label="Human touchpoints" value={metrics.humanTouchpoints.toFixed(1)} note="average per run" />
        <KpiCard icon="success" label="Success rate" value={formatPercent(metrics.successRate)} note="all workflows" featured />
      </section>
      <div className="factory-grid">
        <section className="stage-panel">
          <div className="section-heading"><div><span className="eyebrow">Pipeline health</span><h2>Stage performance</h2></div><span>Success / total runs</span></div>
          {metrics.stageMetrics.length === 0 ? <EmptyState icon="factory" title="No stage data yet" message="Stage metrics will populate after workflows complete." /> : (
            <div className="stage-table">
              <div className="stage-row stage-head"><span>Stage</span><span>Volume</span><span>Success</span><span>Avg. duration</span></div>
              {metrics.stageMetrics.map((stage) => (
                <div className="stage-row" key={stage.stage}>
                  <strong>{stage.stage}</strong>
                  <div className="volume-cell"><span style={{ width: `${Math.max(5, (stage.runs / maxRuns) * 100)}%` }} /><small>{stage.runs}</small></div>
                  <span className={stage.successRate >= 0.9 || stage.successRate >= 90 ? 'metric-good' : 'metric-warn'}>{formatPercent(stage.successRate)}</span>
                  <span>{formatDuration(stage.averageDurationMs)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="recent-panel">
          <div className="section-heading"><div><span className="eyebrow">Latest activity</span><h2>Recent runs</h2></div><button className="text-button" onClick={() => onNavigate('observe')} type="button">View all <Icon name="chevron" /></button></div>
          {recentRuns.length === 0 ? <EmptyState icon="runs" title="Factory is ready" message="Start a workflow to see activity." /> : (
            <div className="recent-runs">{recentRuns.map((run) => <button key={run.id} onClick={() => { sessionStorage.setItem('selectedRunId', run.id); onNavigate('observe'); }} type="button"><span className={`run-state-dot status-${run.status}`} /><span><strong>{run.workflowName}</strong><small>{formatDate(run.startedAt)}</small></span><StatusBadge status={run.status} /></button>)}</div>
          )}
        </section>
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  note,
  featured = false,
}: {
  icon: IconName;
  label: string;
  value: string;
  note: string;
  featured?: boolean;
}) {
  return (
    <article className={`kpi-card ${featured ? 'featured' : ''}`}>
      <span className="kpi-icon"><Icon name={icon} /></span>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
