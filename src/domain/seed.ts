import type { AgentDefinition, ConnectionRecord, PlatformState, ProjectRecord, TenantRecord, WorkflowDefinition } from './types.js';
import { defaultWorkUnit } from './catalog.js';

const createdAt = '2026-08-28T15:00:00.000Z';
const tenantId = 'tenant-local';
const projectId = 'project-local';

const seedTenant: TenantRecord = { id: tenantId, name: 'Local tenant', createdAt };
const seedProject: ProjectRecord = {
  id: projectId,
  tenantId,
  name: 'Default loop',
  description: 'Local development project',
  createdAt,
};

export const seedWorkflow: WorkflowDefinition = {
  tenantId,
  projectId,
  id: 'workflow-agent-intake',
  name: 'Agent-led request intake',
  description:
    'Prepare a request, execute a bounded agent assessment, and notify operators.',
  version: 1,
  status: 'draft',
  trigger: { type: 'manualTrigger' },
  agents: [],
  nodes: [
    {
      id: 'trigger',
      type: 'manualTrigger',
      label: 'Receive request',
      position: { x: 40, y: 180 },
      config: {},
    },
    {
      id: 'prepare',
      type: 'transform',
      label: 'Prepare context',
      position: { x: 300, y: 180 },
      config: { value: 'Validated product request' },
    },
    {
      id: 'agent',
      type: 'agentLoop',
      label: 'Assess request',
      position: { x: 560, y: 180 },
      config: {
        goal: 'Assess feasibility, risk, and the next best action',
        agentId: 'request-assessor',
        maxIterations: 3,
      },
    },
    {
      id: 'notify',
      type: 'notification',
      label: 'Notify operator',
      position: { x: 820, y: 180 },
      config: {
        channel: 'operations',
        message: 'Agent assessment completed',
      },
    },
    {
      id: 'output',
      type: 'output',
      label: 'Return outcome',
      position: { x: 1080, y: 180 },
      config: { value: 'ready-for-review' },
    },
  ],
  edges: [
    { id: 'e-trigger-prepare', source: 'trigger', target: 'prepare' },
    { id: 'e-prepare-agent', source: 'prepare', target: 'agent' },
    { id: 'e-agent-notify', source: 'agent', target: 'notify' },
    { id: 'e-notify-output', source: 'notify', target: 'output' },
  ],
  createdAt,
  updatedAt: createdAt,
};

const seedAgent: AgentDefinition = {
  id: 'request-assessor',
  version: 1,
  name: 'Request assessor',
  purpose: 'Assess feasibility, risk, and the next best action for an incoming request.',
  instructions: 'Produce a concise assessment grounded in the workflow input and stop when the success criteria are met.',
  skills: ['requirements-analysis', 'risk-assessment'],
  tools: [],
  model: { routingAlias: 'default-safe' },
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: { assessment: { type: 'string' } } },
  boundaries: {
    allowedConnections: [],
    allowedRepositories: [],
    protectedPaths: [],
    network: 'deny-by-default',
    dataClasses: ['internal'],
  },
  limits: { maxIterations: 3, maxCostUsd: 0.01, maxDurationMs: 60_000 },
  termination: {
    successConditions: ['Assessment is complete and includes a recommended next action.'],
    failureConditions: ['Required request context is missing.'],
    escalationConditions: ['Risk cannot be classified with available evidence.'],
  },
  approval: { beforeSideEffects: false, beforeTools: [] },
  observability: { captureInputs: false, captureOutputs: false, redactedFields: ['prompt', 'output', 'secret'] },
};

seedWorkflow.agents = [seedAgent];
for (const node of seedWorkflow.nodes) {
  node.unit = defaultWorkUnit(node.type);
}

const seedConnections: ConnectionRecord[] = [
  {
    tenantId,
    projectId,
    id: 'connection-product-api',
    name: 'Product API',
    connector: 'HTTP',
    environment: 'development',
    status: 'healthy',
    scopes: ['api:read'],
    lastCheckedAt: createdAt,
    usageCount: 0,
    secretConfigured: false,
  },
  {
    tenantId,
    projectId,
    id: 'connection-source-control',
    name: 'Source control',
    connector: 'GitHub',
    environment: 'development',
    status: 'healthy',
    scopes: ['contents:read', 'pull_requests:write'],
    lastCheckedAt: createdAt,
    usageCount: 0,
    secretConfigured: false,
  },
];

export function createSeedState(): PlatformState {
  return {
    tenants: [structuredClone(seedTenant)],
    projects: [structuredClone(seedProject)],
    workflows: [structuredClone(seedWorkflow)],
    workflowVersions: [structuredClone(seedWorkflow)],
    runs: [],
    events: [],
    connections: structuredClone(seedConnections),
    proposals: [],
    files: [],
    artifacts: [],
    evidence: [],
    approvals: [],
    deployments: [],
    replayReports: [],
    evaluationDatasets: [],
  };
}
