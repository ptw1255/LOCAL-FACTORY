import type {
  AgentProposal,
  ArtifactRecord,
  ConnectionRecord,
  FactoryMetrics,
  NodeCatalogItem,
  RunEvent,
  OperationEvidence,
  ApprovalRecord,
  DeploymentRecord,
  DeploymentEnvelope,
  DeploymentApprovalRecord,
  RunRecord,
  ProjectRecord,
  ProjectFileRecord,
  ProjectDirectoryRecord,
  ReplayReportRecord,
  EvaluationDatasetRecord,
  SourceDiagnostic,
  TenantRecord,
  ValidationResult,
  WorkflowDefinition,
} from './types';

interface ItemsResponse<T> {
  items: T[];
}

interface ErrorPayload {
  message?: string;
  diagnostics?: SourceDiagnostic[];
}

export class ApiRequestError extends Error {
  public readonly diagnostics?: SourceDiagnostic[];

  public constructor(message: string, diagnostics?: SourceDiagnostic[]) {
    super(message);
    this.name = 'ApiRequestError';
    this.diagnostics = diagnostics;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const tenantId = window.localStorage.getItem('factory.tenantId');
  const projectId = window.localStorage.getItem('factory.projectId');
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(tenantId === null ? {} : { 'X-Tenant-ID': tenantId }),
      ...(projectId === null ? {} : { 'X-Project-ID': projectId }),
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload as ErrorPayload | null;
    throw new ApiRequestError(error?.message ?? `Request failed with status ${response.status}.`, error?.diagnostics);
  }
  return payload as T;
}

async function requestText(path: string): Promise<string> {
  const tenantId = window.localStorage.getItem('factory.tenantId');
  const projectId = window.localStorage.getItem('factory.projectId');
  const response = await fetch(path, {
    headers: {
      Accept: 'text/yaml',
      ...(tenantId === null ? {} : { 'X-Tenant-ID': tenantId }),
      ...(projectId === null ? {} : { 'X-Project-ID': projectId }),
    },
  });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
  return response.text();
}

export const api = {
  health: () => request<{ observability: { retentionHours: number; evidenceRetentionHours: number | null; otlpExportEnabled: boolean; phoenixConfigured: boolean; phoenixUiUrl: string | null } }>('/api/health'),
  tenants: () => request<ItemsResponse<TenantRecord>>('/api/tenants'),
  projects: () => request<ItemsResponse<ProjectRecord>>('/api/projects'),
  createProject: (input: { name: string; description: string }) =>
    request<ProjectRecord>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  cloneWorkflow: (projectId: string, sourceWorkflowId: string, name?: string) =>
    request<WorkflowDefinition>(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ sourceWorkflowId, ...(name === undefined ? {} : { name }) }),
    }),
  declarativeYaml: (projectId: string) =>
    requestText(`/api/projects/${encodeURIComponent(projectId)}/declarative.yaml`),
  importDeclarativeYaml: (projectId: string, source: string) =>
    request<{ project: ProjectRecord; workflows: WorkflowDefinition[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/declarative`,
      { method: 'POST', body: JSON.stringify({ source }) },
    ),
  projectFiles: (projectId: string, search = '') => request<ItemsResponse<ProjectFileRecord> & { directories?: ProjectDirectoryRecord[] }>(`/api/projects/${encodeURIComponent(projectId)}/files${search.trim() === '' ? '' : `?search=${encodeURIComponent(search.trim())}`}`),
  projectFile: (projectId: string, filePath: string) => request<ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(filePath)}`),
  artifacts: (projectId: string) => request<ItemsResponse<ArtifactRecord>>(`/api/projects/${encodeURIComponent(projectId)}/artifacts`),
  artifact: (projectId: string, artifactId: string) => request<ArtifactRecord>(`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`),
  saveProjectFile: (projectId: string, filePath: string, content: string, expectedSha256?: string) => request<ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'PUT', body: JSON.stringify({ path: filePath, content, ...(expectedSha256 === undefined ? {} : { expectedSha256 }) }) }),
  createProjectDirectory: (projectId: string, directoryPath: string) => request<ProjectDirectoryRecord>(`/api/projects/${encodeURIComponent(projectId)}/files/directory`, { method: 'POST', body: JSON.stringify({ path: directoryPath }) }),
  compileProject: (projectId: string, environment = 'local') => request<{ id: string; workflows: WorkflowDefinition[] }>(`/api/projects/${encodeURIComponent(projectId)}/compile`, { method: 'POST', body: JSON.stringify({ environment }) }),
  renameProjectFile: (projectId: string, filePath: string, newPath: string) => request<{ renamed: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'PATCH', body: JSON.stringify({ path: filePath, newPath }) }),
  deleteProjectFile: (projectId: string, filePath: string) => request<{ deleted: boolean; trashId: string }>(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'DELETE', body: JSON.stringify({ path: filePath }) }),
  restoreProjectFile: (projectId: string, trashId: string) => request<ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files/restore`, { method: 'POST', body: JSON.stringify({ trashId }) }),
  catalog: () => request<ItemsResponse<NodeCatalogItem>>('/api/catalog/nodes'),
  workflows: () => request<ItemsResponse<WorkflowDefinition>>('/api/workflows'),
  workflow: (id: string) =>
    request<WorkflowDefinition>(`/api/workflows/${encodeURIComponent(id)}`),
  workflowVersions: (id: string) =>
    request<ItemsResponse<WorkflowDefinition>>(
      `/api/workflows/${encodeURIComponent(id)}/versions`,
    ),
  saveWorkflow: (workflow: WorkflowDefinition) =>
    request<WorkflowDefinition>(`/api/workflows/${encodeURIComponent(workflow.id)}`, {
      method: 'PUT',
      body: JSON.stringify(workflow),
    }),
  validateWorkflow: (id: string) =>
    request<ValidationResult>(`/api/workflows/${encodeURIComponent(id)}/validate`, {
      method: 'POST',
      body: '{}',
    }),
  startRun: (id: string, options: { dryRun?: boolean; artifactId?: string; environment?: string; deploymentId?: string; input?: unknown } = {}) =>
    request<RunRecord>(`/api/workflows/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  dryRun: (id: string, options: { artifactId?: string; environment?: string; deploymentId?: string; input?: unknown } = {}) => request<{ dryRun: true; workflowId: string; workflowVersion: number; artifactId?: string; environment?: string; deploymentId?: string; inputHash?: string; valid: true; issues: [] }>(`/api/workflows/${encodeURIComponent(id)}/runs`, { method: 'POST', body: JSON.stringify({ dryRun: true, ...options }) }),
  runs: () => request<ItemsResponse<RunRecord>>('/api/runs'),
  run: (id: string) => request<RunRecord>(`/api/runs/${encodeURIComponent(id)}`),
  retryRun: (id: string, idempotencyKey?: string) => request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(idempotencyKey === undefined ? {} : { idempotencyKey }) }),
  replay: (id: string, timeoutMs?: number) => request<ReplayReportRecord>(`/api/runs/${encodeURIComponent(id)}/replay`, { method: 'POST', body: JSON.stringify(timeoutMs === undefined ? {} : { timeoutMs }) }),
  replays: (sourceRunId?: string) => request<ItemsResponse<ReplayReportRecord>>(`/api/replays${sourceRunId === undefined ? '' : `?sourceRunId=${encodeURIComponent(sourceRunId)}`}`),
  evaluationDatasets: () => request<ItemsResponse<EvaluationDatasetRecord>>('/api/evaluation-datasets'),
  createEvaluationDataset: (input: { name: string; description?: string; labels?: string[]; reportIds?: string[] }) => request<EvaluationDatasetRecord>('/api/evaluation-datasets', { method: 'POST', body: JSON.stringify(input) }),
  approveRun: (id: string) =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: '{}',
    }),
  denyRun: (id: string, reason = 'Denied by operator') =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/deny`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  expireRun: (id: string, reason = 'Approval expired by operator') =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/expire`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  supersedeRun: (id: string, reason = 'Approval superseded by operator') =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/supersede`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  cancelRun: (id: string) =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
  pauseRun: (id: string) =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
      body: '{}',
    }),
  resumeRun: (id: string) =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: '{}',
    }),
  events: (runId: string) =>
    request<ItemsResponse<RunEvent>>(`/api/events?runId=${encodeURIComponent(runId)}`),
  projectFileEvents: (projectId: string, since?: string) =>
    request<ItemsResponse<RunEvent>>(`/api/projects/${encodeURIComponent(projectId)}/files/events${since === undefined ? '' : `?since=${encodeURIComponent(since)}`}`),
  evidence: (runId: string) =>
    request<ItemsResponse<OperationEvidence>>(`/api/evidence?runId=${encodeURIComponent(runId)}`),
  approvals: (runId: string) =>
    request<ItemsResponse<ApprovalRecord>>(`/api/approvals?runId=${encodeURIComponent(runId)}`),
  telemetry: (runId: string, signal?: 'log' | 'trace' | 'metric') =>
    request<ItemsResponse<RunEvent> & { resource: Record<string, string> }>(
      `/api/telemetry?runId=${encodeURIComponent(runId)}${signal === undefined ? '' : `&signal=${signal}`}`,
    ),
  connections: () => request<ItemsResponse<ConnectionRecord>>('/api/connections'),
  createConnection: (input: {
    name: string;
    connector: string;
    environment: string;
    scopes: string[];
    secret?: string;
  }) =>
    request<ConnectionRecord>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createProposal: (goal: string, workflowId: string) =>
    request<AgentProposal>('/api/agent/proposals', {
      method: 'POST',
      body: JSON.stringify({ goal, workflowId }),
    }),
  factoryMetrics: () => request<FactoryMetrics>('/api/factory/metrics'),
  deployments: () => request<ItemsResponse<DeploymentRecord>>('/api/deployments'),
  deploymentEnvelopes: () => request<ItemsResponse<DeploymentEnvelope>>('/api/deployments?format=envelope'),
  deploymentEvidence: (deploymentId: string) => request<ItemsResponse<OperationEvidence>>(`/api/evidence?deploymentId=${encodeURIComponent(deploymentId)}`),
  deploymentAction: (id: string, action: DeploymentRecord['history'][number]['action'], options: { artifactId?: string; expectedUpdatedAt?: string; idempotencyKey?: string; runId?: string; approvalId?: string } = {}) =>
    request<DeploymentRecord>(`/api/deployments/${encodeURIComponent(id)}/action`, { method: 'POST', body: JSON.stringify({ action, ...options }) }),
  deploymentApprovals: () => request<ItemsResponse<DeploymentApprovalRecord>>('/api/deployment-approvals'),
  requestDeploymentApproval: (deploymentId: string, artifactId: string, runId: string, expiresInMs?: number) =>
    request<DeploymentApprovalRecord>(`/api/deployments/${encodeURIComponent(deploymentId)}/approval`, { method: 'POST', body: JSON.stringify({ action: 'request', artifactId, runId, ...(expiresInMs === undefined ? {} : { expiresInMs }) }) }),
  decideDeploymentApproval: (deploymentId: string, approvalId: string, action: 'approve' | 'deny', reason?: string) =>
    request<DeploymentApprovalRecord>(`/api/deployments/${encodeURIComponent(deploymentId)}/approval`, { method: 'POST', body: JSON.stringify({ action, approvalId, ...(reason === undefined ? {} : { reason }) }) }),
  reconcileDeployment: (id: string) =>
    request<DeploymentRecord>(`/api/deployments/${encodeURIComponent(id)}/reconcile`, { method: 'POST', body: '{}' }),
  createDeployment: (input: { workflowId: string; environment: string; artifactId: string; trigger: string }) =>
    request<DeploymentRecord>('/api/deployments', { method: 'POST', body: JSON.stringify(input) }),
};
