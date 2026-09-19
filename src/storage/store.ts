import type { ArtifactRecord, EvidenceQuery, OperationEvidence, PlatformState, RunEvent } from '../domain/types.js';
import { defaultWorkUnit } from '../domain/catalog.js';

export const DEFAULT_TENANT_ID = 'tenant-local';
export const DEFAULT_PROJECT_ID = 'project-local';

export type StateMutation<T> = (state: PlatformState) => T | Promise<T>;

export interface EventListOptions {
  /** Maximum number of rows to return. Omit for internal, unbounded reads. */
  limit?: number;
  /** Return rows older than this timestamp when paging backwards. */
  before?: string;
}

/** Storage contract shared by the JSON development adapter and PostgreSQL. */
export interface PlatformStore {
  read<T>(select: (state: PlatformState) => T): Promise<T>;
  mutate<T>(mutation: StateMutation<T>): Promise<T>;
  /** Apply a state transition and append its lifecycle event in one store operation. */
  mutateAndAppendEvent?<T>(mutation: StateMutation<{ value: T; event?: RunEvent }>): Promise<{ value: T; eventAppended: boolean }>;
  appendEvent(event: RunEvent): Promise<void>;
  listEvents(runId?: string, options?: EventListOptions): Promise<RunEvent[]>;
  appendEvidence(evidence: OperationEvidence): Promise<void>;
  /** Append an immutable compiled artifact when the backing store supports a dedicated artifact table. */
  appendArtifact?(artifact: ArtifactRecord): Promise<void>;
  listEvidence(query?: string | EvidenceQuery): Promise<OperationEvidence[]>;
  /** Remove observability records older than the configured retention window. */
  pruneEvents?(before: string): Promise<number>;
  /** Remove durable operation evidence older than the configured policy. */
  pruneEvidence?(before: string): Promise<number>;
  close?(): Promise<void>;
}

export function normalizePlatformState(state: PlatformState): PlatformState {
  state.files ??= [];
  state.directories ??= [];
  state.deletedFiles ??= [];
  state.artifacts ??= [];
  state.authoringProposals ??= [];
  state.evidence ??= [];
  state.approvals ??= [];
  state.deployments ??= [];
  state.deploymentApprovals ??= [];
  state.replayReports ??= [];
  state.evaluationDatasets ??= [];
  state.tenants ??= [{
    id: DEFAULT_TENANT_ID,
    name: 'Local tenant',
    createdAt: new Date().toISOString(),
  }];
  state.projects ??= [{
    id: DEFAULT_PROJECT_ID,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Default loop',
    description: 'Local development project',
    createdAt: new Date().toISOString(),
  }];
  if (state.tenants.length === 0) {
    state.tenants.push({ id: DEFAULT_TENANT_ID, name: 'Local tenant', createdAt: new Date().toISOString() });
  }
  if (state.projects.length === 0) {
    state.projects.push({
      id: DEFAULT_PROJECT_ID,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Default loop',
      description: 'Local development project',
      createdAt: new Date().toISOString(),
    });
  }
  const tenantId = state.tenants[0]?.id ?? DEFAULT_TENANT_ID;
  const projectId = state.projects[0]?.id ?? DEFAULT_PROJECT_ID;
  for (const project of state.projects) project.tenantId ??= tenantId;
  state.workflowVersions ??= structuredClone(state.workflows);
  for (const workflow of [...state.workflows, ...state.workflowVersions]) {
    workflow.tenantId ??= tenantId;
    workflow.projectId ??= projectId;
    workflow.agents ??= [];
    for (const node of workflow.nodes ?? []) {
      node.unit ??= defaultWorkUnit(node.type);
    }
  }
  for (const connection of state.connections) {
    connection.tenantId ??= tenantId;
    if (connection.factoryScoped !== true) connection.projectId ??= projectId;
    connection.secretConfigured ??= connection.secretRef !== undefined;
  }
  for (const run of state.runs) {
    run.tenantId ??= run.workflowDefinition.tenantId ?? tenantId;
    run.projectId ??= run.workflowDefinition.projectId ?? projectId;
    run.unitOutputs ??= {};
    run.agentCheckpoints ??= {};
    run.approvedNodeHashes ??= {};
    run.pendingApprovalHashes ??= {};
    run.ciCheckpoints ??= {};
    run.executionEngine ??= 'local';
    run.environment ??= 'local';
  }
  for (const event of state.events) {
    const run = state.runs.find((candidate) => candidate.id === event.runId);
    event.tenantId ??= run?.tenantId ?? tenantId;
    event.projectId ??= run?.projectId ?? projectId;
  }
  for (const proposal of state.proposals) {
    proposal.tenantId ??= proposal.workflow.tenantId ?? tenantId;
    proposal.projectId ??= proposal.workflow.projectId ?? projectId;
  }
  for (const proposal of state.authoringProposals) {
    if (proposal.brief !== undefined) proposal.brief.input ??= 'Structured workflow input';
  }
  for (const deployment of state.deployments) {
    deployment.triggerStatus ??= deployment.desiredState === 'running' ? 'active' : 'inactive';
    deployment.healthyArtifactIds ??= [];
  }
  for (const report of state.replayReports) {
    report.differences ??= [];
    report.completedNodeIds ??= [];
  }
  for (const dataset of state.evaluationDatasets) {
    dataset.cases ??= [];
    dataset.version ??= 1;
    dataset.labels ??= [];
  }
  return state;
}
