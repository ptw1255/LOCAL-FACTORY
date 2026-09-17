export type WorkflowStatus = 'draft' | 'deployed';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';
export type ExecutionEngine = 'local' | 'temporal';
export type ConnectionStatus = 'healthy' | 'degraded' | 'expired';
export type IssueLevel = 'error' | 'warning';
export type ReplayReportStatus = 'passed' | 'mismatch' | 'failed' | 'timed_out';

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

/** An explicitly-created empty directory in a project workspace. */
export interface ProjectDirectoryRecord {
  tenantId: string;
  projectId: string;
  path: string;
  createdAt: string;
}

export interface DeletedProjectFileRecord extends ProjectFileRecord {
  trashId: string;
  deletedAt: string;
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
  /** File-backed source location populated by the resource compiler. */
  sourcePath?: string;
  sourceLine?: number;
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
  idempotencyKey?: string;
  schema: string;
  payload: T;
  contentHash: string;
}

/** A provider route declared by an agent box. Credentials are referenced, never embedded. */
export interface AgentModelRoute {
  provider: string;
  model?: string;
  endpoint?: string;
  secretRef?: string;
  /** Optional adapter contract requirements declared by the workflow author. */
  capabilities?: Array<'text' | 'structured_output' | 'streaming' | 'tools' | 'usage' | 'request_ids'>;
  adapterVersion?: string;
}

export interface AgentModelRouting {
  strategy: 'single' | 'fallback' | 'ensemble';
  maxAttempts?: number;
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
  model: { provider?: string; model?: string; routingAlias?: string; endpoint?: string; secretRef?: string; streaming?: boolean; capabilities?: AgentModelRoute['capabilities']; adapterVersion?: string; pricing?: { promptPer1kUsd: number; completionPer1kUsd: number }; provisioning?: { mode: 'never' | 'pull-on-start' | 'baked'; digest?: string; timeoutMs?: number }; routes?: AgentModelRoute[]; routing?: AgentModelRouting };
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
  /** Optional JSON-Schema subset used to validate input supplied at run time. */
  inputSchema?: Record<string, unknown>;
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

/** A source-anchored diagnostic suitable for editor and API consumers. */
export interface SourceDiagnostic {
  severity: IssueLevel;
  path: string;
  line: number;
  column: number;
  code: string;
  message: string;
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
  /** Content identity of the immutable workflow plus agent release bundle. */
  releaseBundleHash?: string;
  /** Agent IDs and versions pinned when this run was created. */
  pinnedAgentVersions?: Record<string, number>;
  artifactId?: string;
  /** Environment selected for this execution (for example local or staging). */
  environment?: string;
  /** Logical deployment that supplied the selected runtime context. */
  deploymentId?: string;
  /** Initial trigger payload retained so a recovered run can resume deterministically. */
  input?: unknown;
  inputHash?: string;
  /** Source run when this execution was created by deterministic replay. */
  replayOfRunId?: string;
  /** Execution plane that owns this run. */
  executionEngine?: ExecutionEngine;
  /** Temporal identity used to recover or control a durable execution. */
  temporalWorkflowId?: string;
  temporalRunId?: string;
  temporalTaskQueue?: string;
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
  /** Payload-free progress marker used to resume an agent loop after restart. */
  agentCheckpoints?: Record<string, AgentIterationCheckpoint>;
  /** Durable checkpoint for a repository CI observer that may outlive a process. */
  ciCheckpoints: Record<string, CiCheckpoint>;
}

export interface AgentIterationCheckpoint {
  /** The next iteration that must be invoked for this node. */
  nextIteration: number;
  maxIterations: number;
  outputHash?: string;
  updatedAt: string;
}

/** Durable, payload-free comparison result for a replay attempt. */
export interface ReplayReportRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  sourceRunId: string;
  replayRunId: string;
  workflowId: string;
  workflowVersion: number;
  status: ReplayReportStatus;
  differences: string[];
  completedNodeIds: string[];
  durationMs: number;
  sourceOutputHash?: string;
  replayOutputHash?: string;
  createdAt: string;
}

/** A small durable evaluator dataset made from replay reports, never raw payloads. */
export interface EvaluationDatasetCase {
  id: string;
  reportId: string;
  sourceRunId: string;
  replayRunId: string;
  workflowId: string;
  workflowVersion: number;
  status: ReplayReportStatus;
  sourceOutputHash?: string;
  replayOutputHash?: string;
  createdAt: string;
}

export interface EvaluationDatasetRecord {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  version: number;
  labels: string[];
  description?: string;
  createdAt: string;
  cases: EvaluationDatasetCase[];
}

/** Payload-free aggregate score used to decide whether a dataset may promote. */
export interface EvaluationDatasetEvaluation {
  datasetId: string;
  datasetVersion: number;
  totalCases: number;
  passedCases: number;
  nonPassingCases: number;
  statusCounts: Record<ReplayReportStatus, number>;
  passRate: number;
  threshold: number;
  promotionBlocked: boolean;
  evaluatedAt: string;
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
  /** Logical deployment that produced this evidence, when the operation is not run-scoped. */
  deploymentId?: string;
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
  deploymentId?: string;
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
  /** Client-supplied key that makes retried actions idempotent. */
  idempotencyKey?: string;
  /** Optional run that initiated or is associated with this transition. */
  runId?: string;
  /** Stable correlation key shared by transition telemetry and evidence. */
  correlationId?: string;
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
  /** Successful coding-workflow run that most recently verified a protected promotion. */
  lastVerifiedRunId?: string;
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
  directories: ProjectDirectoryRecord[];
  deletedFiles: DeletedProjectFileRecord[];
  artifacts: ArtifactRecord[];
  evidence: OperationEvidence[];
  approvals: ApprovalRecord[];
  deployments: DeploymentRecord[];
  replayReports: ReplayReportRecord[];
  evaluationDatasets: EvaluationDatasetRecord[];
}
