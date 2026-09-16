export type WorkflowStatus = 'draft' | 'deployed';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';
export type ConnectionStatus = 'healthy' | 'degraded' | 'expired';
export type IssueLevel = 'error' | 'warning';

export interface TenantRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface ProjectFileRecord {
  tenantId: string;
  projectId: string;
  path: string;
  content: string;
  sha256: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  tenantId: string;
  projectId: string;
  id: string;
  environment: string;
  compilerVersion: string;
  sources: Array<{ path: string; sha256: string }>;
  workflows: WorkflowDefinition[];
  createdAt: string;
}

export interface Position {
  x: number;
  y: number;
}

export interface WorkflowNode {
  id: string;
  type: string;
  label: string;
  position: Position;
  config: Record<string, unknown>;
  unit?: WorkUnitDefinition;
}

export type AgentSpanKind = 'agent' | 'llm' | 'tool' | 'chain' | 'evaluator';
export type WorkUnitKind =
  | 'deterministic'
  | 'agent'
  | 'human'
  | 'connector'
  | 'consumer'
  | 'evaluator';

export interface WorkUnitDefinition {
  kind: WorkUnitKind;
  version: number;
  inputSchema: string;
  outputSchema: string;
  timeoutMs: number;
  retryAttempts: number;
  idempotencyKey?: string;
}

/** Runtime envelope exchanged between the dispatcher and a WorkUnit adapter. */
export interface WorkUnitEnvelope<T = unknown> {
  runId: string;
  traceId: string;
  unitId: string;
  sequence: number;
  attempt: number;
  schema: string;
  payload: T;
  contentHash: string;
}

/** A versioned, policy-bound agent "box" owned by its workflow definition. */
export interface AgentDefinition {
  id: string;
  version: number;
  name: string;
  purpose: string;
  instructions: string;
  skills: string[];
  tools: string[];
  model: { provider?: string; model?: string; routingAlias?: string; endpoint?: string; secretRef?: string; streaming?: boolean; pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }; provisioning?: { mode: 'never' | 'pull-on-start' | 'baked'; digest?: string; timeoutMs?: number } };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  boundaries: {
    allowedConnections: string[];
    allowedRepositories: string[];
    protectedPaths: string[];
    network: 'deny-by-default' | 'allow-listed';
    dataClasses: string[];
  };
  limits: { maxIterations: number; maxCostUsd: number; maxDurationMs: number; maxTokens?: number };
  termination: { successConditions: string[]; failureConditions: string[]; escalationConditions: string[] };
  approval: { beforeSideEffects: boolean; beforeTools: string[] };
  observability: { captureInputs: boolean; captureOutputs: boolean; redactedFields: string[] };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  condition?: string;
}

export interface WorkflowDefinition {
  tenantId?: string;
  projectId?: string;
  id: string;
  name: string;
  description: string;
  version: number;
  status: WorkflowStatus;
  trigger: {
    type: string;
  };
  agents: AgentDefinition[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface RunRecord {
  tenantId?: string;
  projectId?: string;
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  artifactId?: string;
  traceId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  costUsd: number;
  humanTouchpoints: number;
  error?: string;
  workflowDefinition: WorkflowDefinition;
  completedNodeIds: string[];
  activatedNodeIds: string[];
  approvedNodeIds: string[];
  approvedNodeHashes: Record<string, string>;
  pendingApprovalHashes: Record<string, string>;
  unitOutputs: Record<string, unknown>;
  /** Durable checkpoint for a repository CI observer that may outlive a process. */
  ciCheckpoints: Record<string, CiCheckpoint>;
}

export interface CiCheckpoint {
  ref: string;
  required: string[];
  timeoutMs: number;
  intervalMs: number;
  startedAt: string;
  polls: number;
  lastStatus: 'pending' | 'success' | 'failure' | 'timed_out';
}

export interface RunEvent {
  tenantId?: string;
  projectId?: string;
  id: string;
  runId: string;
  nodeId?: string;
  type: string;
  timestamp: string;
  message: string;
  signal: 'log' | 'trace' | 'metric';
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanKind?: AgentSpanKind;
  severityText?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  attributes?: Record<string, string | number | boolean>;
  data?: Record<string, unknown>;
}

export type OperationEvidenceStatus = 'started' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

/** Durable, redacted record of a unit operation; retained independently of telemetry. */
export interface OperationEvidence {
  id: string;
  tenantId?: string;
  projectId?: string;
  runId: string;
  unitId: string;
  operation: string;
  idempotencyKey?: string;
  actor?: string;
  source?: string;
  correlationId?: string;
  attempt: number;
  status: OperationEvidenceStatus;
  occurredAt: string;
  inputHash?: string;
  outputHash?: string;
  error?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface EvidenceQuery {
  runId?: string;
  tenantId?: string;
  projectId?: string;
  unitId?: string;
  operation?: string;
  status?: OperationEvidenceStatus;
  from?: string;
  to?: string;
  repository?: string;
  revision?: string;
  commit?: string;
  pullRequest?: string;
}

export type ApprovalDecision = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'superseded';

export interface ApprovalRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  runId: string;
  nodeId: string;
  operation: string;
  bindingHash: string;
  decision: ApprovalDecision;
  requestedAt: string;
  expiresAt: string;
  actor?: string;
  reason?: string;
  decidedAt?: string;
}

export type DeploymentDesiredState = 'running' | 'stopped';
export type DeploymentObservedState = 'unknown' | 'starting' | 'live' | 'stopping' | 'degraded' | 'failed' | 'stopped';
export type DeploymentAction = 'deploy' | 'start' | 'stop' | 'restart' | 'rollback';

export interface DeploymentTransition {
  id: string;
  action: DeploymentAction;
  actor: string;
  occurredAt: string;
  fromArtifactId?: string;
  toArtifactId?: string;
  outcome: 'succeeded' | 'failed';
  reason?: string;
}

export interface DeploymentRecord {
  id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  environment: string;
  artifactId: string;
  desiredState: DeploymentDesiredState;
  observedState: DeploymentObservedState;
  health: 'healthy' | 'degraded' | 'unknown';
  trigger: string;
  triggerStatus: 'active' | 'inactive' | 'unknown';
  createdAt: string;
  updatedAt: string;
  lease?: { ownerId: string; expiresAt: string };
  lastError?: string;
  healthyArtifactIds: string[];
  history: DeploymentTransition[];
}

export interface ConnectionRecord {
  tenantId?: string;
  projectId?: string;
  id: string;
  name: string;
  connector: string;
  environment: string;
  status: ConnectionStatus;
  scopes: string[];
  lastCheckedAt: string;
  usageCount: number;
  secretRef?: string;
  secretConfigured: boolean;
}

export interface AgentProposal {
  tenantId?: string;
  projectId?: string;
  id: string;
  workflowId: string;
  goal: string;
  summary: string;
  rationale: string[];
  workflow: WorkflowDefinition;
  issues: ValidationIssue[];
  createdAt: string;
}

export interface NodeCatalogItem {
  type: string;
  label: string;
  category: string;
  description: string;
  defaultConfig: Record<string, unknown>;
}

export interface StageMetric {
  stage: string;
  runs: number;
  successRate: number;
  averageDurationMs: number;
}

export interface FactoryMetrics {
  throughput: number;
  costPerRun: number;
  automationPercent: number;
  humanTouchpoints: number;
  successRate: number;
  stageMetrics: StageMetric[];
}

export interface PlatformState {
  tenants: TenantRecord[];
  projects: ProjectRecord[];
  workflows: WorkflowDefinition[];
  workflowVersions: WorkflowDefinition[];
  runs: RunRecord[];
  events: RunEvent[];
  connections: ConnectionRecord[];
  proposals: AgentProposal[];
  files: ProjectFileRecord[];
  artifacts: ArtifactRecord[];
  evidence: OperationEvidence[];
  approvals: ApprovalRecord[];
  deployments: DeploymentRecord[];
}
