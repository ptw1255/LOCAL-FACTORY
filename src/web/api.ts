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
  RunRecord,
  ProjectRecord,
  ProjectFileRecord,
  TenantRecord,
  ValidationResult,
  WorkflowDefinition,
} from './types';

interface ItemsResponse<T> {
  items: T[];
}

interface ErrorPayload {
  message?: string;
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
    throw new Error(error?.message ?? `Request failed with status ${response.status}.`);
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
  health: () => request<{ observability: { retentionHours: number; evidenceRetentionHours: number | null } }>('/api/health'),
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
  projectFiles: (projectId: string) => request<ItemsResponse<ProjectFileRecord>>(`/api/projects/${encodeURIComponent(projectId)}/files`),
  projectFile: (projectId: string, filePath: string) => request<ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(filePath)}`),
  artifacts: (projectId: string) => request<ItemsResponse<ArtifactRecord>>(`/api/projects/${encodeURIComponent(projectId)}/artifacts`),
  saveProjectFile: (projectId: string, filePath: string, content: string) => request<ProjectFileRecord>(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'PUT', body: JSON.stringify({ path: filePath, content }) }),
  renameProjectFile: (projectId: string, filePath: string, newPath: string) => request<{ renamed: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/files`, { method: 'PATCH', body: JSON.stringify({ path: filePath, newPath }) }),
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
  startRun: (id: string) =>
    request<RunRecord>(`/api/workflows/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: '{}',
    }),
  runs: () => request<ItemsResponse<RunRecord>>('/api/runs'),
  run: (id: string) => request<RunRecord>(`/api/runs/${encodeURIComponent(id)}`),
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
  cancelRun: (id: string) =>
    request<RunRecord>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
  events: (runId: string) =>
    request<ItemsResponse<RunEvent>>(`/api/events?runId=${encodeURIComponent(runId)}`),
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
  deploymentAction: (id: string, action: DeploymentRecord['history'][number]['action'], options: { artifactId?: string; expectedUpdatedAt?: string; idempotencyKey?: string } = {}) =>
    request<DeploymentRecord>(`/api/deployments/${encodeURIComponent(id)}/action`, { method: 'POST', body: JSON.stringify({ action, ...options }) }),
  reconcileDeployment: (id: string) =>
    request<DeploymentRecord>(`/api/deployments/${encodeURIComponent(id)}/reconcile`, { method: 'POST', body: '{}' }),
  createDeployment: (input: { workflowId: string; environment: string; artifactId: string; trigger: string }) =>
    request<DeploymentRecord>('/api/deployments', { method: 'POST', body: JSON.stringify(input) }),
};
