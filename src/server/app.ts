import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
} from 'fastify';

import { ProposalService } from '../agents/proposal-service.js';
import { ConnectionService } from '../connections/connection-service.js';
import { VaultSecretBroker } from '../connections/vault-secret-broker.js';
import { nodeCatalog } from '../domain/catalog.js';
import {
  createProjectSchema,
  cloneWorkflowSchema,
  declarativeImportSchema,
  createConnectionSchema,
  createProposalSchema,
  createTenantSchema,
  workflowDefinitionSchema,
} from '../domain/schema.js';
import type { ArtifactRecord, DeletedProjectFileRecord, EvaluationDatasetCase, EvaluationDatasetEvaluation, ProjectFileRecord, ReplayReportRecord, SourceDiagnostic, WorkflowDefinition } from '../domain/types.js';
import { validateWorkflow } from '../domain/validator.js';
import { validateWorkflowInput } from '../domain/input-schema.js';
import { defaultFactoryManifest } from '../factory/manifest.js';
import { calculateFactoryMetrics } from '../factory/metrics.js';
import { EventService } from '../observability/event-service.js';
import { compileResourceFiles } from '../declarative/resources.js';
import { planResourceMigration } from '../declarative/migration.js';
import { computeArtifactId, diffArtifacts } from '../declarative/artifact.js';
import { parseProjectYaml, stringifyProjectYaml } from '../declarative/yaml.js';
import { CompositeTelemetryExporter, OtlpHttpExporter } from '../observability/otlp-exporter.js';
import type { TelemetryExporter } from '../observability/otlp-exporter.js';
import { OtelSdkExporter } from '../observability/otel-sdk-exporter.js';
import { LocalWorkflowExecutor } from '../runtime/executor.js';
import { WorkflowReplayService } from '../runtime/replay.js';
import { TemporalWorkflowExecutor, type TemporalWorkflowClientLike } from '../temporal/executor.js';
import { HttpOllamaClient } from '../runtime/ollama.js';
import { OpenAISDKClient } from '../runtime/openai-sdk.js';
import { OpenAICompatibleClient } from '../runtime/openai-compatible.js';
import { AnthropicClient } from '../runtime/anthropic.js';
import { GeminiClient } from '../runtime/gemini.js';
import { parseRepositoryCheckSandbox, RepositoryWorkspace } from '../repository/workspace.js';
import { GitHubRepositoryClient } from '../repository/github.js';
import { DeploymentReconciler, type DeploymentRuntimeAdapter } from '../deployment/reconciler.js';
import { toDeploymentEnvelope } from '../deployment/envelope.js';
import type { OpenAIClient } from '../runtime/openai.js';
import { JsonStore } from '../storage/json-store.js';
import { PostgresStore } from '../storage/postgres-store.js';
import { FileArtifactStore, type ArtifactStore } from '../storage/artifact-store.js';
import { ProjectWorkspace } from '../storage/project-workspace.js';
import { DEFAULT_PROJECT_ID, DEFAULT_TENANT_ID, type PlatformStore } from '../storage/store.js';
import { Authenticator, type AuthMode, type AuthToken, parseAuthTokens } from './auth.js';

export interface AppOptions {
  dataFile?: string;
  databaseUrl?: string;
  store?: PlatformStore;
  secretBroker?: import('../connections/secret-broker.js').SecretBroker;
  logger?: boolean;
  serveStatic?: boolean;
  observabilityRetentionHours?: number;
  telemetryExporter?: TelemetryExporter;
  repositoryWorkspace?: RepositoryWorkspace;
  githubRepository?: GitHubRepositoryClient;
  openaiClient?: OpenAIClient;
  openaiCompatibleClient?: OpenAIClient;
  providerClients?: ReadonlyMap<string, OpenAIClient>;
  deploymentAdapter?: DeploymentRuntimeAdapter;
  artifactStore?: ArtifactStore;
  /** Filesystem source-of-truth for authored project files (enabled by WORKSPACE_ROOT in Docker). */
  projectWorkspace?: ProjectWorkspace;
  authMode?: AuthMode;
  authTokens?: readonly AuthToken[];
  executionEngine?: 'local' | 'temporal';
  temporalClient?: TemporalWorkflowClientLike;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected platform error.';
}

function errorDiagnostics(error: unknown): SourceDiagnostic[] {
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  if (Array.isArray(diagnostics)) return diagnostics as SourceDiagnostic[];
  const message = errorMessage(error);
  const sourcePath = message.match(/^([^:]+):\s/)?.[1] ?? 'project.yaml';
  return [{ severity: 'error', path: sourcePath, line: 1, column: 1, code: 'declarative.invalid', message }];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function scopeFromRequest(request: { headers: Record<string, string | string[] | undefined> }) {
  return {
    tenantId: headerValue(request.headers['x-tenant-id']) ?? DEFAULT_TENANT_ID,
    projectId: headerValue(request.headers['x-project-id']) ?? DEFAULT_PROJECT_ID,
  };
}

function inScope(value: { tenantId?: string; projectId?: string }, scope: { tenantId: string; projectId: string }): boolean {
  return value.tenantId === scope.tenantId && value.projectId === scope.projectId;
}

const MAX_PROJECT_FILE_BYTES = 1_000_000;
const allowedProjectFileExtensions = new Set(['.yaml', '.yml', '.json', '.md', '.txt']);

function projectFilePathError(filePath: string, content?: string): string | undefined {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..')) return 'File paths must stay within the project workspace.';
  const base = normalized.split('/').at(-1)?.toLowerCase() ?? '';
  if (base.startsWith('.env') || base === 'credentials.json' || base === 'secrets.yaml') return 'Secret-bearing files are not allowed in the project workspace.';
  const extension = base.includes('.') ? `.${base.split('.').at(-1)}` : '';
  if (!allowedProjectFileExtensions.has(extension)) return 'Only YAML, JSON, Markdown, and text project files are supported.';
  if (content !== undefined && Buffer.byteLength(content, 'utf8') > MAX_PROJECT_FILE_BYTES) return `Project files must be ${MAX_PROJECT_FILE_BYTES} bytes or smaller.`;
  return undefined;
}

function projectDirectoryPathError(directoryPath: string): string | undefined {
  const normalized = directoryPath.replaceAll('\\', '/').replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..' || segment === '')) return 'Directory paths must stay within the project workspace.';
  if (normalized.split('/').some((segment) => segment === '.env' || segment === 'credentials' || segment === 'secrets')) return 'Secret-bearing directories are not allowed in the project workspace.';
  return undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse the standard OTEL_EXPORTER_OTLP_HEADERS key=value list without
 * logging or otherwise exposing credential-bearing values. */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === '') return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const headerValue = entry.slice(separator + 1).trim();
    if (key !== '' && headerValue !== '') headers[key] = headerValue;
  }
  return headers;
}

function telemetryExporter(): CompositeTelemetryExporter | undefined {
  const exporters = [];
  const useOfficialSdk = process.env.OTEL_USE_SDK_EXPORTER !== 'false';
  const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const configuredPhoenixEndpoint = process.env.PHOENIX_ENDPOINT ?? process.env.PHOENIX_COLLECTOR_ENDPOINT;
  const phoenixEndpoint = configuredPhoenixEndpoint?.trim() || undefined;
  const phoenixApiKey = process.env.PHOENIX_API_KEY;
  if (phoenixEndpoint !== undefined) {
    const headers: Record<string, string> = { ...otlpHeaders, ...(phoenixApiKey === undefined ? {} : { api_key: phoenixApiKey }) };
    exporters.push(useOfficialSdk
      ? new OtelSdkExporter(phoenixEndpoint, { headers, signals: ['trace'], deleteTraces: true })
      : new OtlpHttpExporter(phoenixEndpoint, headers, { deleteTraces: true, signals: ['trace'] }));
  }
  const configuredOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otlpEndpoint = configuredOtlpEndpoint?.trim() || undefined;
  if (otlpEndpoint !== undefined && otlpEndpoint !== phoenixEndpoint) {
    exporters.push(useOfficialSdk ? new OtelSdkExporter(otlpEndpoint, { headers: otlpHeaders }) : new OtlpHttpExporter(otlpEndpoint, otlpHeaders));
  }
  return exporters.length === 0 ? undefined : new CompositeTelemetryExporter(exporters);
}

export async function createApp(
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const dataFile =
    options.dataFile ??
    process.env.DATA_FILE ??
    path.join(process.cwd(), '.data', 'state.json');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const store: PlatformStore = options.store ?? (databaseUrl === undefined
    ? new JsonStore(dataFile)
    : new PostgresStore(databaseUrl));
  const vaultAddress = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const secretBroker = options.secretBroker ?? (
    vaultAddress !== undefined && vaultToken !== undefined
      ? new VaultSecretBroker({ address: vaultAddress, token: vaultToken })
      : undefined
  );
  const retentionHours = options.observabilityRetentionHours
    ?? positiveNumber(process.env.OBSERVABILITY_RETENTION_HOURS, 48);
  const evidenceRetentionHours = process.env.EVIDENCE_RETENTION_HOURS === undefined
    ? undefined
    : positiveNumber(process.env.EVIDENCE_RETENTION_HOURS, 1);
  const exporter = options.telemetryExporter ?? telemetryExporter();
  const phoenixUiUrl = process.env.PHOENIX_UI_URL?.trim() || undefined;
  const artifactDirectory = process.env.ARTIFACT_STORE_DIR?.trim() || path.join(path.dirname(dataFile), 'artifacts');
  const artifactStore = options.artifactStore ?? new FileArtifactStore(artifactDirectory);
  const configuredWorkspaceRoot = process.env.WORKSPACE_ROOT?.trim();
  const projectWorkspace = options.projectWorkspace ?? (configuredWorkspaceRoot === undefined || configuredWorkspaceRoot === '' ? undefined : new ProjectWorkspace(configuredWorkspaceRoot));
  const events = new EventService(store, { retentionHours, ...(evidenceRetentionHours === undefined ? {} : { evidenceRetentionHours }), exporter, artifactStore });
  const emitWorkspaceFileEvent = async (scope: { tenantId: string; projectId: string }, operation: 'created' | 'updated' | 'renamed' | 'deleted' | 'restored' | 'directory-created', filePath: string, sha256?: string): Promise<void> => {
    await events.emit(`workspace:${scope.projectId}`, 'workspace.file.changed', `Project file ${operation}.`, {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      signal: 'log',
      severityText: 'INFO',
      attributes: {
        'workspace.file.operation': operation,
        'workspace.file.path': filePath,
        ...(sha256 === undefined ? {} : { 'workspace.file.sha256': sha256 }),
      },
    });
  };
  const workspaceListing = async (scope: { tenantId: string; projectId: string }): Promise<{ files: ProjectFileRecord[]; directories: import('../domain/types.js').ProjectDirectoryRecord[] }> => {
    if (projectWorkspace === undefined) return store.read((state) => ({ files: state.files.filter((file) => file.projectId === scope.projectId && file.tenantId === scope.tenantId), directories: state.directories.filter((directory) => directory.projectId === scope.projectId && directory.tenantId === scope.tenantId) }));
    const listing = await projectWorkspace.list(scope);
    // One-time compatibility migration for projects created before the mounted
    // workspace was enabled. New writes never return to platform_state.
    if (listing.files.length === 0) {
      const legacy = await store.read((state) => state.files.filter((file) => file.projectId === scope.projectId && file.tenantId === scope.tenantId));
      for (const file of legacy) await projectWorkspace.save(scope, file.path, file.content, undefined);
      if (legacy.length > 0) return projectWorkspace.list(scope);
    }
    return listing;
  };
  const configuredAuthMode = options.authMode ?? process.env.FACTORY_AUTH_MODE;
  const authMode: AuthMode = configuredAuthMode === 'required' || (configuredAuthMode === undefined && process.env.NODE_ENV === 'production') ? 'required' : 'local';
  const configuredTokens = options.authTokens ?? parseAuthTokens(process.env.FACTORY_AUTH_TOKENS);
  const authTokens: AuthToken[] = [...configuredTokens];
  const apiToken = process.env.FACTORY_API_TOKEN?.trim();
  if (apiToken !== undefined && apiToken !== '') authTokens.push({ token: apiToken, principal: { id: 'factory-api-token', role: 'admin', tenantIds: ['*'], projectIds: ['*'] } });
  const authenticator = new Authenticator(authMode, authTokens);
  const ollama = new HttpOllamaClient();
  const repositoryWorkspace = options.repositoryWorkspace ?? (process.env.REPOSITORY_WORKSPACE === undefined
    ? undefined
    : await RepositoryWorkspace.open(process.env.REPOSITORY_WORKSPACE));
  const githubRepository = options.githubRepository ?? (process.env.GITHUB_REPOSITORY_OWNER !== undefined && process.env.GITHUB_REPOSITORY_NAME !== undefined && (process.env.GITHUB_TOKEN !== undefined || process.env.GITHUB_SECRET_REF !== undefined)
    ? new GitHubRepositoryClient({ owner: process.env.GITHUB_REPOSITORY_OWNER, repo: process.env.GITHUB_REPOSITORY_NAME, ...(process.env.GITHUB_TOKEN === undefined ? {} : { token: process.env.GITHUB_TOKEN }), ...(process.env.GITHUB_SECRET_REF === undefined ? {} : { secretRef: process.env.GITHUB_SECRET_REF, secretBroker }) })
    : undefined);
  const openai = options.openaiClient ?? new OpenAISDKClient({ secretBroker });
  const openaiCompatible = options.openaiCompatibleClient ?? new OpenAICompatibleClient({ secretBroker });
  const providerClients = options.providerClients ?? new Map<string, OpenAIClient>([
    ['anthropic', new AnthropicClient({ secretBroker })],
    ['gemini', new GeminiClient({ secretBroker })],
  ]);
  const configuredExecutionEngine = options.executionEngine ?? process.env.EXECUTION_ENGINE;
  let temporalClose: (() => Promise<void>) | undefined;
  const executor = configuredExecutionEngine === 'temporal'
    ? (() => {
      if (options.temporalClient !== undefined) return new TemporalWorkflowExecutor({ store, events, client: options.temporalClient, taskQueuePrefix: process.env.TEMPORAL_TASK_QUEUE_PREFIX });
      return undefined;
    })()
    : undefined;
  let runExecutor: LocalWorkflowExecutor | TemporalWorkflowExecutor;
  if (executor !== undefined) {
    runExecutor = executor;
  } else if (configuredExecutionEngine === 'temporal') {
    const connected = await TemporalWorkflowExecutor.connect({
      store,
      events,
      address: process.env.TEMPORAL_ADDRESS,
      namespace: process.env.TEMPORAL_NAMESPACE,
      taskQueuePrefix: process.env.TEMPORAL_TASK_QUEUE_PREFIX,
    });
    runExecutor = connected.executor;
    temporalClose = connected.close;
  } else {
    runExecutor = new LocalWorkflowExecutor(store, events, ollama, undefined, repositoryWorkspace, githubRepository, openai, new Map(), openaiCompatible, providerClients);
  }
  const replayService = new WorkflowReplayService(store, runExecutor);
  const ollamaAgents = await store.read((state) => state.workflows.flatMap((workflow) => workflow.agents).flatMap((agent) => {
    const routes = agent.model.routes ?? [];
    const routeAgents = routes.map((route) => ({ ...agent, model: { ...agent.model, ...route } }));
    return [agent, ...routeAgents];
  }));
  if (ollamaAgents.some((agent) => agent.model.provider?.toLowerCase() === 'ollama' && agent.model.provisioning?.mode === 'pull-on-start')) {
    void ollama.provision(ollamaAgents).catch((error: unknown) => app.log.warn({ error }, 'Ollama model provisioning did not complete; execution will retry on demand.'));
  }
  const connections = new ConnectionService(store, secretBroker);
  const proposals = new ProposalService(store);
  const deployments = new DeploymentReconciler(store, 30_000, options.deploymentAdapter, 3, events);
  const deploymentReconcileIntervalMs = positiveNumber(process.env.DEPLOYMENT_RECONCILE_INTERVAL_MS, 30_000);
  const deploymentReconcileTimer = setInterval(() => {
    void deployments.reconcileAll().catch((error: unknown) => app.log.warn({ error }, 'Deployment reconciliation poll failed.'));
  }, deploymentReconcileIntervalMs);
  deploymentReconcileTimer.unref?.();
  if (store.close !== undefined) {
    app.addHook('onClose', async () => store.close?.());
  }
  if (temporalClose !== undefined) app.addHook('onClose', async () => temporalClose?.());
  const retentionTimer = setInterval(() => void events.prune(), 15 * 60 * 1000);
  retentionTimer.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(retentionTimer);
    clearInterval(deploymentReconcileTimer);
    await events.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || request.url.split('?')[0] === '/api/health') return;
    const scope = scopeFromRequest(request);
    const principal = authenticator.authenticate(headerValue(request.headers.authorization));
    const decision = authenticator.authorize(principal, { method: request.method, url: request.url, ...scope });
    const auditRunId = `auth:${request.id}`;
    void events.emit(auditRunId, decision.allowed ? 'authz.allowed' : 'authz.denied', decision.reason, {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      severityText: decision.allowed ? 'INFO' : 'WARN',
      attributes: {
        'auth.principal': principal?.id ?? 'anonymous',
        'auth.role': principal?.role ?? 'anonymous',
        'auth.required_role': decision.requiredRole,
        'auth.method': request.method,
        'auth.path': request.url.split('?')[0] ?? request.url,
        'auth.allowed': decision.allowed,
      },
    }).catch(() => undefined);
    if (decision.allowed) return;
    return reply.status(principal === undefined ? 401 : 403).send({ error: principal === undefined ? 'Unauthorized' : 'Forbidden', message: decision.reason });
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = error.validation === undefined ? 400 : 422;
    void reply.status(statusCode).send({
      error: error.name,
      message: error.message,
    });
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    executionEngine: runExecutor instanceof TemporalWorkflowExecutor ? 'temporal' : 'local-durable-preview',
    storage: databaseUrl === undefined ? 'json' : 'postgresql',
    observability: {
      retentionHours,
      evidenceRetentionHours: evidenceRetentionHours ?? null,
      otlpExportEnabled: exporter !== undefined,
      exporterHealth: events.exporterHealth() ?? null,
      phoenixConfigured: exporter !== undefined && phoenixUiUrl !== undefined,
      phoenixUiUrl: phoenixUiUrl ?? null,
    },
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/repository', async (_request, reply) => {
    if (repositoryWorkspace === undefined) return reply.status(404).send({ message: 'Repository workspace is not configured.' });
    return { path: repositoryWorkspace.path, entries: await repositoryWorkspace.list() };
  });

  app.post<{ Body: unknown }>('/api/repository/check', async (request, reply) => {
    if (repositoryWorkspace === undefined) return reply.status(404).send({ message: 'Repository workspace is not configured.' });
    const body = request.body as { command?: unknown; timeoutMs?: unknown; sandbox?: unknown };
    if (typeof body?.command !== 'string') return reply.status(422).send({ message: 'A supported check command is required.' });
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
    return repositoryWorkspace.runCheck(body.command, timeoutMs, undefined, { sandbox: body.sandbox === undefined ? undefined : parseRepositoryCheckSandbox(body.sandbox) });
  });

  app.get('/api/repository/patch', async (_request, reply) => {
    if (repositoryWorkspace === undefined) return reply.status(404).send({ message: 'Repository workspace is not configured.' });
    return repositoryWorkspace.patchArtifact();
  });

  app.post<{ Body: unknown }>('/api/repository/pull-request', async (request, reply) => {
    if (repositoryWorkspace === undefined || githubRepository === undefined) return reply.status(404).send({ message: 'Repository and GitHub integration are not configured.' });
    const body = request.body as { title?: unknown; body?: unknown; head?: unknown; base?: unknown };
    if (![body?.title, body?.body, body?.head, body?.base].every((value) => typeof value === 'string' && value.trim() !== '')) return reply.status(422).send({ message: 'title, body, head, and base are required.' });
    return githubRepository.createPullRequest({ title: body.title as string, body: body.body as string, head: body.head as string, base: body.base as string });
  });

  app.get('/api/catalog/nodes', async () => ({ items: nodeCatalog }));

  app.get('/api/tenants', async () => ({
    items: await store.read((state) => state.tenants),
  }));

  app.post<{ Body: unknown }>('/api/tenants', async (request, reply) => {
    const parsed = createTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ message: 'Tenant metadata is invalid.', issues: parsed.error.issues });
    }
    const tenant = {
      id: `tenant-${randomUUID()}`,
      name: parsed.data.name,
      createdAt: new Date().toISOString(),
    };
    await store.mutate((state) => {
      state.tenants.push(tenant);
    });
    return tenant;
  });

  app.get('/api/projects', async (request) => {
    const { tenantId } = scopeFromRequest(request);
    return { items: await store.read((state) => state.projects.filter((project) => project.tenantId === tenantId)) };
  });

  app.post<{ Body: unknown }>('/api/projects', async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ message: 'Project metadata is invalid.', issues: parsed.error.issues });
    }
    const scope = scopeFromRequest(request);
    const tenantId = parsed.data.tenantId ?? scope.tenantId;
    const project = {
      id: `project-${randomUUID()}`,
      tenantId,
      name: parsed.data.name,
      description: parsed.data.description,
      createdAt: new Date().toISOString(),
    };
    const exists = await store.read((state) => state.tenants.some((tenant) => tenant.id === tenantId));
    if (!exists) return reply.status(404).send({ message: 'Tenant not found.' });
    await store.mutate((state) => {
      state.projects.push(project);
    });
    return project;
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/workflows',
    async (request, reply) => {
      const parsed = cloneWorkflowSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ message: 'Workflow clone request is invalid.', issues: parsed.error.issues });
      }
      const scope = scopeFromRequest(request);
      let cloned: WorkflowDefinition;
      try {
        cloned = await store.mutate((state) => {
        const project = state.projects.find((candidate) =>
          candidate.id === request.params.projectId && candidate.tenantId === scope.tenantId,
        );
        if (project === undefined) throw new Error('Project not found.');
        const source = state.workflows.find((candidate) =>
          candidate.id === parsed.data.sourceWorkflowId && inScope(candidate, scope),
        );
        if (source === undefined) throw new Error('Source workflow not found.');
        const now = new Date().toISOString();
        const workflow: WorkflowDefinition = {
          ...structuredClone(source),
          tenantId: scope.tenantId,
          projectId: project.id,
          id: `workflow-${randomUUID()}`,
          name: parsed.data.name ?? `${source.name} copy`,
          version: 1,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        };
        state.workflows.push(workflow);
        state.workflowVersions.push(structuredClone(workflow));
        return workflow;
        });
      } catch (error) {
        return reply.status(404).send({ message: errorMessage(error) });
      }
      return cloned;
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/declarative.yaml',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const payload = await store.read((state) => {
        const project = state.projects.find((candidate) => candidate.id === request.params.projectId && candidate.tenantId === scope.tenantId);
        if (project === undefined) return undefined;
        const workflows = state.workflows.filter((workflow) => workflow.projectId === project.id && workflow.tenantId === scope.tenantId);
        return stringifyProjectYaml(project, workflows);
      });
      if (payload === undefined) return reply.status(404).send({ message: 'Project not found.' });
      return reply
        .header('Deprecation', 'true')
        .header('Link', `</api/projects/${encodeURIComponent(request.params.projectId)}/files>; rel="successor-version"`)
        .type('text/yaml')
        .send(payload);
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/declarative',
    async (request, reply) => {
      const parsed = declarativeImportSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(422).send({ message: 'Declarative YAML payload is invalid.', issues: parsed.error.issues });
      const scope = scopeFromRequest(request);
      try {
        const imported = parseProjectYaml(parsed.data.source, { tenantId: scope.tenantId, projectId: request.params.projectId });
        imported.project.id = request.params.projectId;
        await store.mutate((state) => {
          const projectIndex = state.projects.findIndex((project) => project.id === request.params.projectId && project.tenantId === scope.tenantId);
          if (projectIndex < 0) throw new Error('Project not found.');
          state.projects[projectIndex] = imported.project;
          state.workflows = state.workflows.filter((workflow) => !(workflow.projectId === request.params.projectId && workflow.tenantId === scope.tenantId));
          state.workflowVersions = state.workflowVersions.filter((workflow) => !(workflow.projectId === request.params.projectId && workflow.tenantId === scope.tenantId));
          state.workflows.push(...imported.workflows);
          state.workflowVersions.push(...structuredClone(imported.workflows));
        });
        reply
          .header('Deprecation', 'true')
          .header('Link', `</api/projects/${encodeURIComponent(request.params.projectId)}/files>; rel="successor-version"`);
        return { project: imported.project, workflows: imported.workflows };
      } catch (error) {
        return reply.status(422).send({ message: errorMessage(error), diagnostics: errorDiagnostics(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { path?: string; search?: string } }>(
    '/api/projects/:projectId/files',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const fileScope = { tenantId: scope.tenantId, projectId: request.params.projectId };
      const projectExists = await store.read((state) => state.projects.some((project) => project.id === fileScope.projectId && project.tenantId === fileScope.tenantId));
      if (!projectExists) return reply.status(404).send({ message: 'Project not found.' });
      const listing = await workspaceListing(fileScope);
      const files = listing.files;
      const search = request.query.search?.trim().toLowerCase() ?? '';
      if (request.query.path === undefined) {
        const matching = search === '' ? files : files.filter((file) => file.path.toLowerCase().includes(search) || file.content.toLowerCase().includes(search));
        return { items: matching.map(({ content: _content, ...file }) => file), directories: listing.directories };
      }
      const file = files.find((candidate) => candidate.path === request.query.path);
      if (file === undefined) return reply.status(404).send({ message: 'Project file not found.' });
      return file;
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { since?: string } }>(
    '/api/projects/:projectId/files/events',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      if (scope.projectId !== request.params.projectId) return reply.status(404).send({ message: 'Project not found.' });
      const projectExists = await store.read((state) => state.projects.some((project) => project.id === request.params.projectId && project.tenantId === scope.tenantId));
      if (!projectExists) return reply.status(404).send({ message: 'Project not found.' });
      const since = request.query.since;
      const items = (await events.list())
        .filter((event) => event.type === 'workspace.file.changed' && event.tenantId === scope.tenantId && event.projectId === request.params.projectId)
        .filter((event) => since === undefined || event.timestamp > since);
      return { items };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files/directory',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      if (scope.projectId !== request.params.projectId) return reply.status(404).send({ message: 'Project not found.' });
      const body = request.body as { path?: unknown };
      if (typeof body?.path !== 'string') return reply.status(422).send({ message: 'Directory path is required.' });
      const directoryPath = body.path.replaceAll('\\', '/').replace(/\/+$/, '');
      const pathError = projectDirectoryPathError(directoryPath);
      if (pathError !== undefined) return reply.status(422).send({ message: pathError });
      const projectExists = await store.read((state) => state.projects.some((project) => project.id === request.params.projectId && project.tenantId === scope.tenantId));
      if (!projectExists) return reply.status(404).send({ message: 'Project not found.' });
      if (projectWorkspace !== undefined) {
        const result = await projectWorkspace.createDirectory({ tenantId: scope.tenantId, projectId: request.params.projectId }, directoryPath);
        if (result.status === 'exists') return reply.status(409).send({ message: 'A directory already exists at that path.' });
        await emitWorkspaceFileEvent(scope, 'directory-created', directoryPath);
        return result.directory;
      }
      const directory = { tenantId: scope.tenantId, projectId: request.params.projectId, path: directoryPath, createdAt: new Date().toISOString() };
      const created = await store.mutate((state) => {
        if (state.directories.some((candidate) => candidate.tenantId === directory.tenantId && candidate.projectId === directory.projectId && candidate.path === directory.path)) return false;
        state.directories.push(directory);
        return true;
      });
      if (!created) return reply.status(409).send({ message: 'A directory already exists at that path.' });
      await emitWorkspaceFileEvent(scope, 'directory-created', directory.path);
      return directory;
    },
  );

  app.put<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { path?: unknown; content?: unknown; expectedSha256?: unknown };
      if (typeof body?.path !== 'string' || typeof body.content !== 'string' || body.path.trim() === '') {
        return reply.status(422).send({ message: 'File path and text content are required.' });
      }
      const pathError = projectFilePathError(body.path, body.content);
      if (pathError !== undefined) return reply.status(422).send({ message: pathError });
      const projectExists = await store.read((state) => state.projects.some((project) => project.id === request.params.projectId && project.tenantId === scope.tenantId));
      if (!projectExists) return reply.status(404).send({ message: 'Project not found.' });
      const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256 : typeof request.headers['if-match'] === 'string' ? request.headers['if-match'].replace(/^\"|\"$/g, '') : undefined;
      if (projectWorkspace !== undefined) {
        const existed = await projectWorkspace.read({ tenantId: scope.tenantId, projectId: request.params.projectId }, body.path);
        const saved = await projectWorkspace.save({ tenantId: scope.tenantId, projectId: request.params.projectId }, body.path, body.content, expectedSha256);
        if (saved.status === 'conflict' || saved.file === undefined) return reply.status(409).send({ message: 'File changed since it was loaded; refresh before saving.' });
        await emitWorkspaceFileEvent(scope, existed === undefined ? 'created' : 'updated', saved.file.path, saved.file.sha256);
        return saved.file;
      }
      const existed = await store.read((state) => state.files.some((candidate) => candidate.projectId === request.params.projectId && candidate.tenantId === scope.tenantId && candidate.path === body.path));
      const file: ProjectFileRecord = {
        tenantId: scope.tenantId,
        projectId: request.params.projectId,
        path: body.path,
        content: body.content,
        sha256: createHash('sha256').update(body.content).digest('hex'),
        updatedAt: new Date().toISOString(),
      };
      const saved = await store.mutate((state) => {
        const index = state.files.findIndex((candidate) => candidate.projectId === file.projectId && candidate.tenantId === file.tenantId && candidate.path === file.path);
        if (index < 0) {
          state.files.push(file);
          return true;
        }
        const current = state.files[index];
        if (expectedSha256 !== undefined && current?.sha256 !== expectedSha256) return false;
        state.files[index] = file;
        return true;
      });
      if (!saved) return reply.status(409).send({ message: 'File changed since it was loaded; refresh before saving.' });
      await emitWorkspaceFileEvent(scope, existed ? 'updated' : 'created', file.path, file.sha256);
      return file;
    },
  );

  app.put<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files/batch',
    async (request, reply) => {
      const scope = { ...scopeFromRequest(request), projectId: request.params.projectId };
      const body = request.body as { files?: unknown };
      if (!Array.isArray(body?.files) || body.files.length === 0 || body.files.length > 128) return reply.status(422).send({ message: 'A batch must contain between 1 and 128 files.' });
      const files = body.files.map((value) => value !== null && typeof value === 'object' ? value as { path?: unknown; content?: unknown; expectedSha256?: unknown } : undefined);
      if (files.some((file) => file === undefined || typeof file.path !== 'string' || typeof file.content !== 'string' || file.path.trim() === '')) return reply.status(422).send({ message: 'Each batch file requires a path and text content.' });
      const writes = files as Array<{ path: string; content: string; expectedSha256?: unknown }>;
      for (const file of writes) {
        const pathError = projectFilePathError(file.path, file.content);
        if (pathError !== undefined) return reply.status(422).send({ message: pathError });
      }
      const projectExists = await store.read((state) => state.projects.some((project) => project.id === scope.projectId && project.tenantId === scope.tenantId));
      if (!projectExists) return reply.status(404).send({ message: 'Project not found.' });
      const normalizedWrites = writes.map((file) => ({ path: file.path, content: file.content, ...(typeof file.expectedSha256 === 'string' ? { expectedSha256: file.expectedSha256 } : {}) }));
      if (projectWorkspace !== undefined) {
        const existingPaths = new Set((await Promise.all(normalizedWrites.map((file) => projectWorkspace.read(scope, file.path)))).flatMap((file) => file === undefined ? [] : [file.path]));
        const saved = await projectWorkspace.saveMany(scope, normalizedWrites);
        if (saved.status === 'conflict' || saved.files === undefined) return reply.status(409).send({ message: 'One or more files changed since they were loaded; refresh before saving.' });
        for (const file of saved.files) await emitWorkspaceFileEvent(scope, existingPaths.has(file.path) ? 'updated' : 'created', file.path, file.sha256);
        return { files: saved.files };
      }
      const existingPaths = new Set(await store.read((state) => state.files.filter((file) => file.projectId === scope.projectId && file.tenantId === scope.tenantId && normalizedWrites.some((write) => write.path === file.path)).map((file) => file.path)));
      const result = await store.mutate((state) => {
        const currentByPath = new Map(state.files.filter((file) => file.projectId === scope.projectId && file.tenantId === scope.tenantId).map((file) => [file.path, file]));
        for (const file of normalizedWrites) {
          const current = currentByPath.get(file.path);
          if (file.expectedSha256 !== undefined && current?.sha256 !== file.expectedSha256) return undefined;
        }
        const now = new Date().toISOString();
        const savedFiles = normalizedWrites.map((file) => ({ ...file, tenantId: scope.tenantId, projectId: scope.projectId, sha256: createHash('sha256').update(file.content).digest('hex'), updatedAt: now }));
        for (const file of savedFiles) {
          const index = state.files.findIndex((candidate) => candidate.projectId === scope.projectId && candidate.tenantId === scope.tenantId && candidate.path === file.path);
          if (index < 0) state.files.push(file);
          else state.files[index] = file;
        }
        return savedFiles;
      });
      if (result === undefined) return reply.status(409).send({ message: 'One or more files changed since they were loaded; refresh before saving.' });
      for (const file of result) await emitWorkspaceFileEvent(scope, existingPaths.has(file.path) ? 'updated' : 'created', file.path, file.sha256);
      return { files: result };
    },
  );

  app.patch<{ Params: { projectId: string }; Body: unknown }>('/api/projects/:projectId/files', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const body = request.body as { path?: unknown; newPath?: unknown };
    if (typeof body?.path !== 'string' || typeof body.newPath !== 'string' || body.newPath.trim() === '') return reply.status(422).send({ message: 'path and newPath are required.' });
    const newPathError = projectFilePathError(body.newPath);
    if (newPathError !== undefined) return reply.status(422).send({ message: newPathError });
    const oldPath = body.path;
    const newPath = body.newPath;
    if (projectWorkspace !== undefined) {
      const renamed = await projectWorkspace.rename({ tenantId: scope.tenantId, projectId: request.params.projectId }, oldPath, newPath);
      if (renamed.status === 'missing') return reply.status(404).send({ message: 'Project file not found.' });
      if (renamed.status === 'conflict') return reply.status(409).send({ message: 'A file already exists at the destination path.' });
      await emitWorkspaceFileEvent(scope, 'renamed', newPath);
      return { renamed: true, path: oldPath, newPath };
    }
    const renamed = await store.mutate((state) => {
      const file = state.files.find((candidate) => candidate.projectId === request.params.projectId && candidate.tenantId === scope.tenantId && candidate.path === oldPath);
      if (file === undefined) return false;
      if (state.files.some((candidate) => candidate.projectId === request.params.projectId && candidate.tenantId === scope.tenantId && candidate.path === newPath)) throw new Error('A file already exists at the destination path.');
      file.path = newPath;
      file.updatedAt = new Date().toISOString();
      return true;
    });
    if (!renamed) return reply.status(404).send({ message: 'Project file not found.' });
    await emitWorkspaceFileEvent(scope, 'renamed', newPath);
    return { renamed: true, path: oldPath, newPath };
  });

  app.delete<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { path?: unknown };
      if (typeof body?.path !== 'string' || body.path.trim() === '') return reply.status(422).send({ message: 'File path is required.' });
      if (projectWorkspace !== undefined) {
        const removed = await projectWorkspace.remove({ tenantId: scope.tenantId, projectId: request.params.projectId }, body.path);
        if (removed === undefined) return reply.status(404).send({ message: 'Project file not found.' });
        await emitWorkspaceFileEvent(scope, 'deleted', removed.path, removed.sha256);
        return { deleted: true, path: body.path, trashId: removed.trashId };
      }
      const removed = await store.mutate((state) => {
        const index = state.files.findIndex((file) => file.projectId === request.params.projectId && file.tenantId === scope.tenantId && file.path === body.path);
        if (index < 0) return undefined;
        const file = state.files[index];
        if (file === undefined) return undefined;
        const trash: DeletedProjectFileRecord = { ...file, trashId: `trash-${randomUUID()}`, deletedAt: new Date().toISOString() };
        state.files.splice(index, 1);
        state.deletedFiles.unshift(trash);
        return trash;
      });
      if (removed === undefined) return reply.status(404).send({ message: 'Project file not found.' });
      await emitWorkspaceFileEvent(scope, 'deleted', removed.path, removed.sha256);
      return { deleted: true, path: body.path, trashId: removed.trashId };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files/restore',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { trashId?: unknown };
      if (typeof body?.trashId !== 'string' || body.trashId.trim() === '') return reply.status(422).send({ message: 'trashId is required.' });
      if (projectWorkspace !== undefined) {
        const restored = await projectWorkspace.restore({ tenantId: scope.tenantId, projectId: request.params.projectId }, body.trashId);
        if (restored === undefined) return reply.status(404).send({ message: 'Deleted project file not found.' });
        await emitWorkspaceFileEvent(scope, 'restored', restored.path, restored.sha256);
        return restored;
      }
      const restored = await store.mutate((state) => {
        const index = state.deletedFiles.findIndex((file) => file.trashId === body.trashId && file.projectId === request.params.projectId && file.tenantId === scope.tenantId);
        if (index < 0) return undefined;
        const deleted = state.deletedFiles[index];
        if (deleted === undefined) return undefined;
        if (state.files.some((file) => file.projectId === request.params.projectId && file.tenantId === scope.tenantId && file.path === deleted.path)) throw new Error('A file already exists at the deleted file path.');
        const { trashId: _trashId, deletedAt: _deletedAt, ...file } = deleted;
        state.deletedFiles.splice(index, 1);
        state.files.push(file);
        return file;
      });
      if (restored === undefined) return reply.status(404).send({ message: 'Deleted project file not found.' });
      await emitWorkspaceFileEvent(scope, 'restored', restored.path, restored.sha256);
      return restored;
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/compile',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { environment?: unknown };
      const environment = typeof body?.environment === 'string' && body.environment.trim() !== '' ? body.environment : 'local';
      const files = (await workspaceListing({ tenantId: scope.tenantId, projectId: request.params.projectId })).files;
      try {
        const compiled = compileResourceFiles(files.map((file) => ({ path: file.path, source: file.content })), { tenantId: scope.tenantId, projectId: request.params.projectId, environment });
        const sources = files.map((file) => ({ path: file.path, sha256: file.sha256 }));
        const compilerVersion = '0.1.0';
        const artifact: ArtifactRecord = { tenantId: scope.tenantId, projectId: request.params.projectId, id: computeArtifactId({ environment, compilerVersion, sources, workflows: compiled.workflows }), environment, compilerVersion, sources, workflows: compiled.workflows, createdAt: new Date().toISOString() };
        await store.appendArtifact?.(artifact);
        await store.mutate((state) => {
          if (!state.artifacts.some((candidate) => candidate.id === artifact.id && candidate.projectId === artifact.projectId && candidate.tenantId === artifact.tenantId)) state.artifacts.push(artifact);
          // Resource files are the authoring boundary. Keep the mutable
          // compatibility index aligned with the last successful compile so
          // subsequent API runs and reloads do not fall back to stale
          // aggregate WorkflowDefinition records. The immutable artifact
          // remains the execution pin; this index is only the latest source
          // projection for legacy consumers.
          const current = new Map(
            state.workflows
              .filter((workflow) => workflow.projectId === request.params.projectId && workflow.tenantId === scope.tenantId)
              .map((workflow) => [workflow.id, workflow]),
          );
          state.workflows = state.workflows.filter((workflow) => !(workflow.projectId === request.params.projectId && workflow.tenantId === scope.tenantId));
          const compiledAt = new Date().toISOString();
          for (const workflow of compiled.workflows) {
            const prior = current.get(workflow.id);
            const synced = {
              ...workflow,
              ...(prior?.createdAt === undefined ? {} : { createdAt: prior.createdAt }),
              updatedAt: compiledAt,
            };
            state.workflows.push(synced);
            if (!state.workflowVersions.some((candidate) => candidate.id === synced.id && candidate.version === synced.version && candidate.projectId === synced.projectId && candidate.tenantId === synced.tenantId)) {
              state.workflowVersions.push(structuredClone(synced));
            }
          }
        });
        return artifact;
      } catch (error) {
        return reply.status(422).send({ message: errorMessage(error), diagnostics: errorDiagnostics(error) });
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/migrate',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const source = await store.read((state) => {
        const project = state.projects.find((candidate) => candidate.id === request.params.projectId && candidate.tenantId === scope.tenantId);
        if (project === undefined) return undefined;
        return { project, workflows: state.workflows.filter((workflow) => workflow.projectId === project.id && workflow.tenantId === scope.tenantId) };
      });
      if (source === undefined) return reply.status(404).send({ message: 'Project not found.' });
      const plan = planResourceMigration(source.project, source.workflows);
      const body = (request.body ?? {}) as { dryRun?: unknown };
      if (body.dryRun !== false) return { dryRun: true, plan };
      const existing = (await workspaceListing(scope)).files;
      const current = new Map(existing.map((file) => [file.path, file]));
      const changed = plan.files.filter((candidate) => current.get(candidate.path)?.content !== candidate.source);
      const backup: Array<{ path: string; trashId?: string }> = [];
      try {
        if (projectWorkspace !== undefined) {
          for (const candidate of changed) {
            const prior = current.get(candidate.path);
            if (prior !== undefined) {
              const removed = await projectWorkspace.remove(scope, candidate.path);
              if (removed !== undefined) backup.push({ path: candidate.path, trashId: removed.trashId });
            }
            const saved = await projectWorkspace.save(scope, candidate.path, candidate.source);
            if (saved.file === undefined) throw new Error(`Migration could not write ${candidate.path}.`);
            await emitWorkspaceFileEvent(scope, prior === undefined ? 'created' : 'updated', saved.file.path, saved.file.sha256);
          }
        } else {
          const now = new Date().toISOString();
          const records = changed.map((candidate): ProjectFileRecord => ({
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            path: candidate.path,
            content: candidate.source,
            sha256: createHash('sha256').update(candidate.source).digest('hex'),
            updatedAt: now,
          }));
          const backups = changed.flatMap((candidate) => {
            const prior = current.get(candidate.path);
            return prior === undefined ? [] : [{ ...prior, trashId: `trash-${randomUUID()}`, deletedAt: now } satisfies DeletedProjectFileRecord];
          });
          await store.mutate((state) => {
            state.deletedFiles.unshift(...backups);
            for (const record of records) {
              const index = state.files.findIndex((file) => file.tenantId === scope.tenantId && file.projectId === scope.projectId && file.path === record.path);
              if (index < 0) state.files.push(record);
              else state.files[index] = record;
            }
          });
          backup.push(...backups.map((item) => ({ path: item.path, trashId: item.trashId })));
          for (const record of records) await emitWorkspaceFileEvent(scope, current.has(record.path) ? 'updated' : 'created', record.path, record.sha256);
        }
        return { dryRun: false, migrated: true, changedPaths: changed.map((candidate) => candidate.path), backup, plan };
      } catch (error) {
        if (projectWorkspace !== undefined) {
          // Roll back changed generated files before restoring their trash
          // entries so a partial migration never replaces the usable source.
          for (const candidate of [...changed].reverse()) {
            const currentFile = await projectWorkspace.read(scope, candidate.path).catch(() => undefined);
            if (currentFile !== undefined && currentFile.content !== current.get(candidate.path)?.content) {
              await projectWorkspace.remove(scope, candidate.path).catch(() => undefined);
            }
          }
          for (const item of [...backup].reverse()) {
            if (item.trashId !== undefined) await projectWorkspace.restore(scope, item.trashId).catch(() => undefined);
          }
        }
        return reply.status(422).send({ message: `Migration failed: ${errorMessage(error)}`, plan, backup });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/artifacts', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.artifacts.filter((artifact) => artifact.projectId === request.params.projectId && artifact.tenantId === scope.tenantId)) };
  });

  app.get<{ Params: { projectId: string }; Querystring: { from?: string; to?: string } }>(
    '/api/projects/:projectId/artifacts/diff',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      if (typeof request.query.from !== 'string' || typeof request.query.to !== 'string' || request.query.from.trim() === '' || request.query.to.trim() === '') {
        return reply.status(422).send({ message: 'from and to artifact IDs are required.' });
      }
      const result = await store.read((state) => {
        const artifacts = state.artifacts.filter((artifact) => artifact.projectId === request.params.projectId && artifact.tenantId === scope.tenantId);
        const from = artifacts.find((artifact) => artifact.id === request.query.from);
        const to = artifacts.find((artifact) => artifact.id === request.query.to);
        return from === undefined || to === undefined ? undefined : diffArtifacts(from, to);
      });
      if (result === undefined) return reply.status(404).send({ message: 'One or both artifacts were not found.' });
      return result;
    },
  );

  app.get<{ Params: { projectId: string; artifactId: string } }>(
    '/api/projects/:projectId/artifacts/:artifactId',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const artifact = await store.read((state) => state.artifacts.find((candidate) =>
        candidate.id === request.params.artifactId
        && candidate.projectId === request.params.projectId
        && candidate.tenantId === scope.tenantId,
      ));
      if (artifact === undefined) return reply.status(404).send({ message: 'Artifact not found.' });
      return artifact;
    },
  );

  app.get('/api/workflows', async (request) => {
    const scope = scopeFromRequest(request);
    return {
      items: await store.read((state) => state.workflows.filter((workflow) => inScope(workflow, scope))),
    };
  });

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const workflow = await store.read((state) =>
      state.workflows.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope)),
    );
    if (workflow === undefined) {
      return reply.status(404).send({ message: 'Workflow not found.' });
    }
    return workflow;
  });

  app.get<{ Params: { id: string } }>(
    '/api/workflows/:id/versions',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const exists = await store.read((state) =>
        state.workflows.some((workflow) => workflow.id === request.params.id && inScope(workflow, scope)),
      );
      if (!exists) {
        return reply.status(404).send({ message: 'Workflow not found.' });
      }
      const versions = await store.read((state) =>
        state.workflowVersions
          .filter((workflow) => workflow.id === request.params.id && inScope(workflow, scope))
          .sort((left, right) => right.version - left.version),
      );
      return { items: versions };
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/workflows/:id/versions/:version',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const version = Number(request.params.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        return reply.status(400).send({ message: 'Workflow version must be a positive integer.' });
      }
      const workflow = await store.read((state) =>
        state.workflowVersions.find(
          (candidate) =>
            candidate.id === request.params.id &&
            candidate.version === version &&
            inScope(candidate, scope),
        ),
      );
      if (workflow === undefined) {
        return reply.status(404).send({ message: 'Workflow version not found.' });
      }
      return workflow;
    },
  );

  app.put<{ Params: { id: string }; Body: WorkflowDefinition }>(
    '/api/workflows/:id',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const parsed = workflowDefinitionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({
          message: 'Workflow schema is invalid.',
          issues: parsed.error.issues,
        });
      }
      const incoming: WorkflowDefinition = {
        ...parsed.data,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
      };
      const validation = validateWorkflow(incoming);
      if (!validation.valid) {
        return reply.status(422).send({
          message: 'Workflow graph is invalid.',
          issues: validation.issues,
        });
      }

      const saved = await store.mutate((state) => {
        const index = state.workflows.findIndex(
          (candidate) => candidate.id === request.params.id && candidate.projectId === scope.projectId,
        );
        if (index < 0) {
          throw new Error('Workflow not found.');
        }
        const current = state.workflows[index];
        if (current === undefined) {
          throw new Error('Workflow not found.');
        }
        if (incoming.id !== request.params.id) {
          throw new Error('Workflow ID cannot be changed.');
        }
        if (incoming.version !== current.version) {
          throw new Error(
            `Workflow version conflict: expected ${current.version}, received ${incoming.version}.`,
          );
        }
        const next: WorkflowDefinition = {
          ...incoming,
          version: current.version + 1,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        };
        state.workflows[index] = next;
        state.workflowVersions.push(structuredClone(next));
        return next;
      });
      return saved;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/workflows/:id/validate',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const workflow = await store.read((state) =>
        state.workflows.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope)),
      );
      if (workflow === undefined) {
        return reply.status(404).send({ message: 'Workflow not found.' });
      }
      return validateWorkflow(workflow);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/workflows/:id/runs',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = (request.body ?? {}) as { artifactId?: unknown; deploymentId?: unknown; environment?: unknown; input?: unknown; dryRun?: unknown };
      const requestedDeploymentId = typeof body.deploymentId === 'string' && body.deploymentId.trim() !== '' ? body.deploymentId.trim() : undefined;
      const selected = await store.read((state) => {
        const deployment = requestedDeploymentId === undefined ? undefined : state.deployments.find((candidate) => candidate.id === requestedDeploymentId && inScope(candidate, scope));
        const requestedArtifactId = typeof body?.artifactId === 'string' && body.artifactId.trim() !== '' ? body.artifactId.trim() : deployment?.artifactId;
        const artifact = requestedArtifactId === undefined ? undefined : state.artifacts.find((candidate) => candidate.id === requestedArtifactId && inScope(candidate, scope));
        const workflow = state.workflows.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope));
        const pinned = artifact?.workflows.find((candidate) => candidate.id === request.params.id);
        return { workflow: pinned ?? workflow, artifactId: artifact?.id, artifactEnvironment: artifact?.environment, deployment };
      });
      if (requestedDeploymentId !== undefined && selected.deployment === undefined) return reply.status(404).send({ message: 'Deployment not found.' });
      if (selected.deployment !== undefined && selected.deployment.workflowId !== request.params.id) return reply.status(422).send({ message: 'Deployment does not reference the selected workflow.' });
      if (typeof body.artifactId === 'string' && selected.deployment !== undefined && body.artifactId !== selected.deployment.artifactId) return reply.status(422).send({ message: 'Selected artifact does not match the deployment context.' });
      const workflow = selected.workflow;
      if (workflow === undefined) {
        return reply.status(404).send({ message: 'Workflow not found.' });
      }
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return reply.status(422).send({ message: 'Workflow must pass validation before it can run.', issues: validation.issues });
      const inputValidation = validateWorkflowInput(workflow.inputSchema, body.input);
      if (!inputValidation.valid) return reply.status(422).send({ message: 'Workflow input is invalid.', issues: inputValidation.issues });
      const environment = typeof body.environment === 'string' && body.environment.trim() !== ''
        ? body.environment.trim()
        : selected.deployment?.environment ?? selected.artifactEnvironment ?? 'local';
      if (environment.length > 50 || /[\r\n]/.test(environment)) return reply.status(422).send({ message: 'Environment must be a short single-line value.' });
      const inputHash = body.input === undefined ? undefined : createHash('sha256').update(JSON.stringify(body.input) ?? 'undefined').digest('hex');
      if (body.dryRun === true) {
        return { dryRun: true, workflowId: workflow.id, workflowVersion: workflow.version, artifactId: selected.artifactId, environment, ...(selected.deployment?.id === undefined ? {} : { deploymentId: selected.deployment.id }), ...(inputHash === undefined ? {} : { inputHash }), valid: true, issues: [] };
      }
      try {
      return await runExecutor.start(workflow, {
        ...(selected.artifactId === undefined ? {} : { artifactId: selected.artifactId }),
        environment,
        ...(selected.deployment?.id === undefined ? {} : { deploymentId: selected.deployment.id }),
        ...(body.input === undefined ? {} : { input: body.input }),
      });
      } catch (error) {
        return reply.status(422).send({ message: errorMessage(error) });
      }
    },
  );

  app.get('/api/runs', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.runs.filter((run) => inScope(run, scope))) };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/runs/:id/replay', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const source = await store.read((state) => state.runs.find((run) => run.id === request.params.id && inScope(run, scope)));
    if (source === undefined) return reply.status(404).send({ message: 'Run not found.' });
    const body = request.body as { timeoutMs?: unknown };
    try {
      return await replayService.replay(source.id, typeof body?.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {});
    } catch (error) {
      return reply.status(422).send({ message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/runs/:id/retry', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const source = await store.read((state) => state.runs.find((run) => run.id === request.params.id && inScope(run, scope)));
    if (source === undefined) return reply.status(404).send({ message: 'Run not found.' });
    try {
      const body = (request.body ?? {}) as { idempotencyKey?: unknown };
      return await runExecutor.retry(source.id, typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {});
    } catch (error) {
      return reply.status(409).send({ message: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { sourceRunId?: string; status?: ReplayReportRecord['status'] } }>('/api/replays', async (request) => {
    const scope = scopeFromRequest(request);
    return {
      items: await store.read((state) => state.replayReports.filter((report) =>
        inScope(report, scope)
        && (request.query.sourceRunId === undefined || report.sourceRunId === request.query.sourceRunId)
        && (request.query.status === undefined || report.status === request.query.status),
      )),
    };
  });

  app.get<{ Params: { id: string } }>('/api/replays/:id', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const report = await store.read((state) => state.replayReports.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope)));
    if (report === undefined) return reply.status(404).send({ message: 'Replay report not found.' });
    return report;
  });

  app.get('/api/evaluation-datasets', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.evaluationDatasets.filter((dataset) => inScope(dataset, scope))) };
  });

  app.get<{ Params: { id: string } }>('/api/evaluation-datasets/:id', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const dataset = await store.read((state) => state.evaluationDatasets.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope)));
    if (dataset === undefined) return reply.status(404).send({ message: 'Evaluation dataset not found.' });
    return dataset;
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/evaluation-datasets/:id/evaluate', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const body = (request.body ?? {}) as { threshold?: unknown };
    const threshold = body.threshold === undefined ? 1 : body.threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return reply.status(422).send({ message: 'threshold must be a number between 0 and 1.' });
    try {
      return await store.mutate((state) => {
        const dataset = state.evaluationDatasets.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope));
        if (dataset === undefined) throw new Error('Evaluation dataset not found.');
        const statusCounts: Record<ReplayReportRecord['status'], number> = { passed: 0, mismatch: 0, failed: 0, timed_out: 0 };
        for (const evaluationCase of dataset.cases) statusCounts[evaluationCase.status] += 1;
        const totalCases = dataset.cases.length;
        const passedCases = statusCounts.passed;
        const passRate = totalCases === 0 ? 0 : Number((passedCases / totalCases).toFixed(6));
        const evaluation: EvaluationDatasetEvaluation = {
          datasetId: dataset.id,
          datasetVersion: dataset.version,
          totalCases,
          passedCases,
          nonPassingCases: totalCases - passedCases,
          statusCounts,
          passRate,
          threshold,
          promotionBlocked: passRate < threshold,
          evaluatedAt: new Date().toISOString(),
        };
        dataset.lastEvaluation = evaluation;
        return evaluation;
      });
    } catch (error) {
      if (errorMessage(error) === 'Evaluation dataset not found.') return reply.status(404).send({ message: 'Evaluation dataset not found.' });
      throw error;
    }
  });

  app.post<{ Body: unknown }>('/api/evaluation-datasets', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const body = request.body as { name?: unknown; description?: unknown; labels?: unknown; reportIds?: unknown };
    if (typeof body?.name !== 'string' || body.name.trim() === '') return reply.status(422).send({ message: 'A dataset name is required.' });
    const datasetName = body.name.trim();
    if (body.description !== undefined && typeof body.description !== 'string') return reply.status(422).send({ message: 'Dataset description must be a string.' });
    if (body.labels !== undefined && (!Array.isArray(body.labels) || !body.labels.every((label) => typeof label === 'string' && label.trim() !== ''))) return reply.status(422).send({ message: 'labels must be an array of non-empty strings.' });
    if (body.reportIds !== undefined && (!Array.isArray(body.reportIds) || !body.reportIds.every((id) => typeof id === 'string' && id.trim() !== ''))) return reply.status(422).send({ message: 'reportIds must be an array of report IDs.' });
    const labels = body.labels === undefined ? [] : [...new Set((body.labels as string[]).map((label) => label.trim()))];
    const requestedReportIds = body.reportIds === undefined ? undefined : [...new Set((body.reportIds as string[]).map((id) => id.trim()))];
    try {
      return await store.mutate((state) => {
        const reports = state.replayReports
          .filter((report) => inScope(report, scope))
          .filter((report) => requestedReportIds === undefined || requestedReportIds.includes(report.id));
        if (requestedReportIds !== undefined && reports.length !== requestedReportIds.length) throw new Error('One or more replay reports were not found in the requested project scope.');
        if (reports.length === 0) throw new Error('At least one replay report is required to materialize an evaluation dataset.');
        const createdAt = new Date().toISOString();
        const version = state.evaluationDatasets
          .filter((dataset) => dataset.tenantId === scope.tenantId && dataset.projectId === scope.projectId && dataset.name === datasetName)
          .reduce((latest, dataset) => Math.max(latest, dataset.version ?? 1), 0) + 1;
        const cases: EvaluationDatasetCase[] = reports.map((report) => ({
          id: `evaluation-case-${randomUUID()}`,
          reportId: report.id,
          sourceRunId: report.sourceRunId,
          replayRunId: report.replayRunId,
          workflowId: report.workflowId,
          workflowVersion: report.workflowVersion,
          status: report.status,
          ...(report.sourceOutputHash === undefined ? {} : { sourceOutputHash: report.sourceOutputHash }),
          ...(report.replayOutputHash === undefined ? {} : { replayOutputHash: report.replayOutputHash }),
          createdAt,
        }));
        const dataset = {
          id: `evaluation-dataset-${randomUUID()}`,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          name: datasetName,
          version,
          labels,
          ...(typeof body.description === 'string' && body.description.trim() === '' ? {} : typeof body.description === 'string' ? { description: body.description.trim() } : {}),
          createdAt,
          cases,
        };
        state.evaluationDatasets.unshift(dataset);
        return dataset;
      });
    } catch (error) {
      return reply.status(422).send({ message: errorMessage(error) });
    }
  });

  app.get('/api/deployments', async (request) => {
    const items = await deployments.list(scopeFromRequest(request));
    const format = (request.query as { format?: unknown }).format;
    return { items: format === 'envelope' ? items.map(toDeploymentEnvelope) : items };
  });

  app.get('/api/deployment-approvals', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.deploymentApprovals.filter((approval) => inScope(approval, scope))) };
  });

  app.post<{ Body: unknown }>('/api/deployments', async (request, reply) => {
    const body = request.body as { workflowId?: unknown; environment?: unknown; artifactId?: unknown; trigger?: unknown };
    if (![body?.workflowId, body?.environment, body?.artifactId, body?.trigger].every((value) => typeof value === 'string' && value.trim() !== '')) return reply.status(422).send({ message: 'workflowId, environment, artifactId, and trigger are required.' });
    try {
      return await deployments.create({ scope: scopeFromRequest(request), workflowId: body.workflowId as string, environment: body.environment as string, artifactId: body.artifactId as string, trigger: body.trigger as string });
    } catch (error) {
      return reply.status(422).send({ message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/deployments/:id/action', async (request, reply) => {
    const body = request.body as { action?: unknown; artifactId?: unknown; reason?: unknown; expectedUpdatedAt?: unknown; idempotencyKey?: unknown; runId?: unknown; approvalId?: unknown };
    const actions = new Set(['deploy', 'start', 'stop', 'restart', 'rollback']);
    if (typeof body?.action !== 'string' || !actions.has(body.action)) return reply.status(422).send({ message: 'A supported deployment action is required.' });
    try {
      return await deployments.action(request.params.id, scopeFromRequest(request), body.action as import('../domain/types.js').DeploymentAction, {
        ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
        ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}),
        ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
        ...(typeof body.approvalId === 'string' ? { approvalId: body.approvalId } : {}),
      });
    } catch (error) {
      return reply.status(409).send({ message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/deployments/:id/approval', async (request, reply) => {
    const body = request.body as { action?: unknown; approvalId?: unknown; artifactId?: unknown; runId?: unknown; reason?: unknown; expiresInMs?: unknown };
    if (body?.action === 'request') {
      if (typeof body.artifactId !== 'string' || typeof body.runId !== 'string') return reply.status(422).send({ message: 'artifactId and runId are required to request deployment approval.' });
      try {
        return await deployments.requestApproval(request.params.id, scopeFromRequest(request), { artifactId: body.artifactId, runId: body.runId, ...(typeof body.expiresInMs === 'number' ? { expiresInMs: body.expiresInMs } : {}) });
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    }
    if ((body?.action === 'approve' || body?.action === 'deny') && typeof body.approvalId === 'string') {
      try {
        return await deployments.decideApproval(request.params.id, scopeFromRequest(request), body.approvalId, body.action === 'approve' ? 'approved' : 'denied', { ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) });
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    }
    return reply.status(422).send({ message: 'Approval action must be request, approve, or deny.' });
  });

  app.post<{ Params: { id: string } }>('/api/deployments/:id/reconcile', async (request, reply) => {
    try { return await deployments.reconcile(request.params.id, scopeFromRequest(request)); }
    catch (error) { return reply.status(409).send({ message: errorMessage(error) }); }
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const run = await store.read((state) =>
      state.runs.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope)),
    );
    if (run === undefined) {
      return reply.status(404).send({ message: 'Run not found.' });
    }
    return run;
  });

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/approve',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        const body = (request.body ?? {}) as Record<string, unknown>;
        return await runExecutor.approve(request.params.id, {
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/runs/:id/deny',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        const body = (request.body ?? {}) as Record<string, unknown>;
        return await runExecutor.deny(request.params.id, {
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/runs/:id/expire',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        const body = (request.body ?? {}) as Record<string, unknown>;
        return await runExecutor.expire(request.params.id, {
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/runs/:id/supersede',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        const body = (request.body ?? {}) as Record<string, unknown>;
        return await runExecutor.supersede(request.params.id, {
          ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/cancel',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        return await runExecutor.cancel(request.params.id);
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/pause',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        return await runExecutor.pause(request.params.id);
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/resume',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
        if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
        return await runExecutor.resume(request.params.id);
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id/tool-checkpoints', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const run = await store.read((state) => state.runs.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope)));
    if (run === undefined) return reply.status(404).send({ message: 'Run not found.' });
    const items = await store.read((state) => state.evidence
      .filter((evidence) => evidence.runId === run.id && evidence.operation === 'agent.tool' && evidence.status === 'started' && evidence.idempotencyKey?.endsWith(':started'))
      .filter((started) => state.evidence.every((candidate) => !(
        candidate.runId === run.id
        && candidate.unitId === started.unitId
        && candidate.operation === 'agent.tool'
        && candidate.idempotencyKey === `${started.idempotencyKey?.slice(0, -':started'.length)}:succeeded`
        && candidate.status === 'succeeded'
      )))
      .map((started) => ({
        evidenceId: started.id,
        unitId: started.unitId,
        callId: started.idempotencyKey?.slice(0, -':started'.length) ?? '',
        status: 'incomplete' as const,
        occurredAt: started.occurredAt,
        correlationId: started.correlationId,
      })));
    return { items };
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/runs/:id/tool-recovery', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const belongs = await store.read((state) => state.runs.some((run) => run.id === request.params.id && inScope(run, scope)));
    if (!belongs) return reply.status(404).send({ message: 'Run not found.' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.unitId !== 'string' || typeof body.callId !== 'string' || (body.resolution !== 'succeeded' && body.resolution !== 'failed') || typeof body.reason !== 'string') {
      return reply.status(422).send({ message: 'unitId, callId, resolution, and reason are required.' });
    }
    if (!('recoverToolCheckpoint' in runExecutor)) {
      return reply.status(409).send({ message: 'Tool checkpoint recovery is only supported by the local execution plane.' });
    }
    try {
      return await runExecutor.recoverToolCheckpoint(request.params.id, {
        unitId: body.unitId,
        callId: body.callId,
        resolution: body.resolution,
        reason: body.reason,
        ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
        ...(typeof body.outputHash === 'string' ? { outputHash: body.outputHash } : {}),
      });
    } catch (error) {
      return reply.status(409).send({ message: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { runId?: string } }>('/api/events', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: (await events.list(request.query.runId)).filter((event) => inScope(event, scope)) };
  });

  app.get<{ Querystring: { runId?: string; deploymentId?: string; tenantId?: string; projectId?: string; unitId?: string; operation?: string; status?: import('../domain/types.js').OperationEvidenceStatus; from?: string; to?: string; repository?: string; revision?: string; commit?: string; pullRequest?: string } }>('/api/evidence', async (request) => {
    const scope = scopeFromRequest(request);
    return {
      items: (await events.listEvidence({
        ...(request.query.runId === undefined ? {} : { runId: request.query.runId }),
        ...(request.query.deploymentId === undefined ? {} : { deploymentId: request.query.deploymentId }),
        ...(request.query.tenantId === undefined ? {} : { tenantId: request.query.tenantId }),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
        ...(request.query.unitId === undefined ? {} : { unitId: request.query.unitId }),
        ...(request.query.operation === undefined ? {} : { operation: request.query.operation }),
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
        ...(request.query.from === undefined ? {} : { from: request.query.from }),
        ...(request.query.to === undefined ? {} : { to: request.query.to }),
        ...(request.query.repository === undefined ? {} : { repository: request.query.repository }),
        ...(request.query.revision === undefined ? {} : { revision: request.query.revision }),
        ...(request.query.commit === undefined ? {} : { commit: request.query.commit }),
        ...(request.query.pullRequest === undefined ? {} : { pullRequest: request.query.pullRequest }),
      })).filter((entry) => inScope(entry, scope)),
    };
  });

  app.get<{ Querystring: { runId?: string } }>('/api/approvals', async (request) => {
    const scope = scopeFromRequest(request);
    return {
      items: await store.read((state) => state.approvals.filter((approval) =>
        (request.query.runId === undefined || approval.runId === request.query.runId) && inScope(approval, scope))),
    };
  });

  app.get<{
    Querystring: { runId?: string; signal?: 'log' | 'trace' | 'metric' };
  }>('/api/telemetry', async (request) => {
    const scope = scopeFromRequest(request);
    const items = (await events.list(request.query.runId)).filter((event) => inScope(event, scope));
    return {
      resource: {
        'service.name': 'agentic-workflow-factory',
        'telemetry.sdk.name': 'opentelemetry',
        'openinference.version': '1',
      },
      items: request.query.signal === undefined
        ? items
        : items.filter((event) => event.signal === request.query.signal),
    };
  });

  app.get('/api/connections', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await connections.list(scope.projectId, scope.tenantId) };
  });

  app.post<{ Body: unknown }>('/api/connections', async (request, reply) => {
    const parsed = createConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        message: 'Connection metadata is invalid.',
        issues: parsed.error.issues,
      });
    }
    try {
      const scope = scopeFromRequest(request);
      return await connections.create({ ...parsed.data, ...scope });
    } catch (error) {
      return reply.status(409).send({ message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/connections/:id/check',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      try {
        return await connections.check(request.params.id, scope.projectId, scope.tenantId);
      } catch (error) {
        return reply.status(404).send({ message: errorMessage(error) });
      }
    },
  );

  app.post<{ Body: unknown }>('/api/agent/proposals', async (request, reply) => {
    const parsed = createProposalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({
        message: 'Agent proposal request is invalid.',
        issues: parsed.error.issues,
      });
    }
    const scope = scopeFromRequest(request);
    const workflow = await store.read((state) =>
      state.workflows.find(
        (candidate) => candidate.id === parsed.data.workflowId && inScope(candidate, scope),
      ),
    );
    if (workflow === undefined) {
      return reply.status(404).send({ message: 'Workflow not found.' });
    }
    return proposals.create(workflow, parsed.data.goal);
  });

  app.get('/api/agent/proposals', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.proposals.filter((proposal) => inScope(proposal, scope))) };
  });

  app.get('/api/factory/metrics', async (request) => {
    const scope = scopeFromRequest(request);
    const runs = await store.read((state) => state.runs.filter((run) => inScope(run, scope)));
    return calculateFactoryMetrics(runs);
  });

  app.get('/api/factory/manifest', async () => defaultFactoryManifest);

  const staticRoot = path.join(process.cwd(), 'dist');
  if ((options.serveStatic ?? true) && existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ message: 'API route not found.' });
      }
      return reply.sendFile('index.html');
    });
  }

  await events.prune();
  await runExecutor.recover();
  return app;
}
