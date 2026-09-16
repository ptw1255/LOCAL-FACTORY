export type ViewId = 'studio' | 'observe' | 'runs' | 'connections' | 'proposals' | 'factory';
export type WorkflowStatus = 'draft' | 'deployed';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type ConnectionStatus = 'healthy' | 'degraded' | 'expired';

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
  attempt: number;
  status: 'started' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  occurredAt: string;
  inputHash?: string;
  outputHash?: string;
  error?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AgentDefinition {
  id: string;
  version: number;
  name: string;
  purpose: string;
  instructions: string;
  skills: string[];
  tools: string[];
  model: { provider?: string; model?: string; routingAlias?: string; endpoint?: string; secretRef?: string; provisioning?: { mode: 'never' | 'pull-on-start' | 'baked'; digest?: string; timeoutMs?: number } };
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
  traceId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  costUsd: number;
  humanTouchpoints: number;
  error?: string;
  unitOutputs?: Record<string, unknown>;
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
