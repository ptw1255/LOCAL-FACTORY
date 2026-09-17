export type ViewId = 'studio' | 'observe' | 'runs' | 'connections' | 'proposals' | 'factory' | 'deployments';
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
  content?: string;
  sha256: string;
  updatedAt: string;
}

export interface ProjectDirectoryRecord {
  tenantId: string;
  projectId: string;
  path: string;
  createdAt: string;
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
  sourcePath?: string;
  sourceLine?: number;
  unit?: WorkUnitDefinition;
}

export interface WorkUnitDefinition {
  kind: 'deterministic' | 'agent' | 'human' | 'connector' | 'consumer' | 'evaluator';
  version: number;
  inputSchema: string;
  outputSchema: string;
  timeoutMs: number;
  retryAttempts: number;
  idempotencyKey?: string;
}

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
  status: 'started' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  occurredAt: string;
  inputHash?: string;
  outputHash?: string;
  error?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface ApprovalRecord {
  id: string;
  tenantId?: string;
  projectId?: string;
  runId: string;
  nodeId: string;
  operation: string;
  bindingHash: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'superseded';
  requestedAt: string;
  expiresAt: string;
  actor?: string;
  reason?: string;
  decidedAt?: string;
}

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
  trigger: { type: string };
  inputSchema?: Record<string, unknown>;
  agents: AgentDefinition[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
}

export interface SourceDiagnostic {
  severity: 'error' | 'warning';
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
  releaseBundleHash?: string;
  pinnedAgentVersions?: Record<string, number>;
  artifactId?: string;
  environment?: string;
  deploymentId?: string;
  input?: unknown;
  inputHash?: string;
  traceId: string;
  executionEngine?: ExecutionEngine;
  temporalWorkflowId?: string;
  temporalRunId?: string;
  temporalTaskQueue?: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  costUsd: number;
  humanTouchpoints: number;
  error?: string;
  unitOutputs?: Record<string, unknown>;
  ciCheckpoints?: Record<string, { ref: string; required: string[]; timeoutMs: number; intervalMs: number; startedAt: string; polls: number; lastStatus: 'pending' | 'success' | 'failure' | 'timed_out' }>;
}

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
  spanKind?: 'agent' | 'llm' | 'tool' | 'chain' | 'evaluator';
  severityText?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  attributes?: Record<string, string | number | boolean>;
  data?: Record<string, unknown>;
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

export interface DeploymentTransition {
  id: string;
  action: 'deploy' | 'start' | 'stop' | 'restart' | 'rollback';
  actor: string;
  occurredAt: string;
  fromArtifactId?: string;
  toArtifactId?: string;
  idempotencyKey?: string;
  runId?: string;
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
  desiredState: 'running' | 'stopped';
  observedState: 'unknown' | 'starting' | 'live' | 'stopping' | 'degraded' | 'failed' | 'stopped';
  health: 'healthy' | 'degraded' | 'unknown';
  trigger: string;
  triggerStatus: 'active' | 'inactive' | 'unknown';
  createdAt: string;
  updatedAt: string;
  lease?: { ownerId: string; expiresAt: string };
  lastError?: string;
  healthyArtifactIds?: string[];
  history: DeploymentTransition[];
}

/** Public lean deployment contract used by operational consumers. */
export interface DeploymentEnvelope {
  apiVersion: 'factory.agentic/v1';
  kind: 'Deployment';
  metadata: { id: string; projectId: string };
  spec: { workflowId: string; environment: string; artifactId: string; desiredState: 'live' | 'stopped' };
  status: { observedState: 'stopped' | 'starting' | 'live' | 'degraded' | 'stopping' | 'failed'; updatedAt: string; error: string | null };
}

export interface AgentProposal {
  id: string;
  summary: string;
  rationale: string[] | string;
  workflow: WorkflowDefinition;
  issues: ValidationIssue[];
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

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  nodeType: string;
  category: string;
  description: string;
  config: Record<string, unknown>;
  unit?: WorkUnitDefinition;
}
