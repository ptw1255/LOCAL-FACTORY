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
import type { ArtifactRecord, ProjectFileRecord, WorkflowDefinition } from '../domain/types.js';
import { validateWorkflow } from '../domain/validator.js';
import { defaultFactoryManifest } from '../factory/manifest.js';
import { calculateFactoryMetrics } from '../factory/metrics.js';
import { EventService } from '../observability/event-service.js';
import { compileResourceFiles } from '../declarative/resources.js';
import { parseProjectYaml, stringifyProjectYaml } from '../declarative/yaml.js';
import { CompositeTelemetryExporter, OtlpHttpExporter } from '../observability/otlp-exporter.js';
import { LocalWorkflowExecutor } from '../runtime/executor.js';
import { HttpOllamaClient } from '../runtime/ollama.js';
import { HttpOpenAIClient } from '../runtime/openai.js';
import { RepositoryWorkspace } from '../repository/workspace.js';
import { GitHubRepositoryClient } from '../repository/github.js';
import { DeploymentReconciler } from '../deployment/reconciler.js';
import type { OpenAIClient } from '../runtime/openai.js';
import { JsonStore } from '../storage/json-store.js';
import { PostgresStore } from '../storage/postgres-store.js';
import { DEFAULT_PROJECT_ID, DEFAULT_TENANT_ID, type PlatformStore } from '../storage/store.js';

export interface AppOptions {
  dataFile?: string;
  databaseUrl?: string;
  store?: PlatformStore;
  secretBroker?: import('../connections/secret-broker.js').SecretBroker;
  logger?: boolean;
  serveStatic?: boolean;
  observabilityRetentionHours?: number;
  repositoryWorkspace?: RepositoryWorkspace;
  githubRepository?: GitHubRepositoryClient;
  openaiClient?: OpenAIClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected platform error.';
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

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function telemetryExporter(): CompositeTelemetryExporter | undefined {
  const exporters = [];
  const configuredPhoenixEndpoint = process.env.PHOENIX_ENDPOINT ?? process.env.PHOENIX_COLLECTOR_ENDPOINT;
  const phoenixEndpoint = configuredPhoenixEndpoint?.trim() || undefined;
  const phoenixApiKey = process.env.PHOENIX_API_KEY;
  if (phoenixEndpoint !== undefined) {
    exporters.push(new OtlpHttpExporter(
      phoenixEndpoint,
      phoenixApiKey === undefined ? {} : { api_key: phoenixApiKey },
      { deleteTraces: true, signals: ['trace'] },
    ));
  }
  const configuredOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const otlpEndpoint = configuredOtlpEndpoint?.trim() || undefined;
  if (otlpEndpoint !== undefined && otlpEndpoint !== phoenixEndpoint) {
    exporters.push(new OtlpHttpExporter(otlpEndpoint));
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
  const exporter = telemetryExporter();
  const events = new EventService(store, { retentionHours, ...(evidenceRetentionHours === undefined ? {} : { evidenceRetentionHours }), exporter });
  const ollama = new HttpOllamaClient();
  const repositoryWorkspace = options.repositoryWorkspace ?? (process.env.REPOSITORY_WORKSPACE === undefined
    ? undefined
    : await RepositoryWorkspace.open(process.env.REPOSITORY_WORKSPACE));
  const githubRepository = options.githubRepository ?? (process.env.GITHUB_REPOSITORY_OWNER !== undefined && process.env.GITHUB_REPOSITORY_NAME !== undefined && (process.env.GITHUB_TOKEN !== undefined || process.env.GITHUB_SECRET_REF !== undefined)
    ? new GitHubRepositoryClient({ owner: process.env.GITHUB_REPOSITORY_OWNER, repo: process.env.GITHUB_REPOSITORY_NAME, ...(process.env.GITHUB_TOKEN === undefined ? {} : { token: process.env.GITHUB_TOKEN }), ...(process.env.GITHUB_SECRET_REF === undefined ? {} : { secretRef: process.env.GITHUB_SECRET_REF, secretBroker }) })
    : undefined);
  const openai = options.openaiClient ?? new HttpOpenAIClient({ secretBroker });
  const executor = new LocalWorkflowExecutor(store, events, ollama, undefined, repositoryWorkspace, githubRepository, openai);
  const ollamaAgents = await store.read((state) => state.workflows.flatMap((workflow) => workflow.agents));
  if (ollamaAgents.some((agent) => agent.model.provider?.toLowerCase() === 'ollama' && agent.model.provisioning?.mode === 'pull-on-start')) {
    void ollama.provision(ollamaAgents).catch((error: unknown) => app.log.warn({ error }, 'Ollama model provisioning did not complete; execution will retry on demand.'));
  }
  const connections = new ConnectionService(store, secretBroker);
  const proposals = new ProposalService(store);
  const deployments = new DeploymentReconciler(store);
  if (store.close !== undefined) {
    app.addHook('onClose', async () => store.close?.());
  }
  const retentionTimer = setInterval(() => void events.prune(), 15 * 60 * 1000);
  retentionTimer.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(retentionTimer);
    await events.close();
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
    executionEngine: 'local-durable-preview',
    storage: databaseUrl === undefined ? 'json' : 'postgresql',
    observability: {
      retentionHours,
      evidenceRetentionHours: evidenceRetentionHours ?? null,
      otlpExportEnabled: exporter !== undefined,
    },
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/repository', async (_request, reply) => {
    if (repositoryWorkspace === undefined) return reply.status(404).send({ message: 'Repository workspace is not configured.' });
    return { path: repositoryWorkspace.path, entries: await repositoryWorkspace.list() };
  });

  app.post<{ Body: unknown }>('/api/repository/check', async (request, reply) => {
    if (repositoryWorkspace === undefined) return reply.status(404).send({ message: 'Repository workspace is not configured.' });
    const body = request.body as { command?: unknown; timeoutMs?: unknown };
    if (typeof body?.command !== 'string') return reply.status(422).send({ message: 'A supported check command is required.' });
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
    return repositoryWorkspace.runCheck(body.command, timeoutMs);
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
      return reply.type('text/yaml').send(payload);
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
        return { project: imported.project, workflows: imported.workflows };
      } catch (error) {
        return reply.status(422).send({ message: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    '/api/projects/:projectId/files',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const files = await store.read((state) => state.files.filter((file) => file.projectId === request.params.projectId && file.tenantId === scope.tenantId));
      if (request.query.path === undefined) return { items: files.map(({ content: _content, ...file }) => file) };
      const file = files.find((candidate) => candidate.path === request.query.path);
      if (file === undefined) return reply.status(404).send({ message: 'Project file not found.' });
      return file;
    },
  );

  app.put<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { path?: unknown; content?: unknown };
      if (typeof body?.path !== 'string' || typeof body.content !== 'string' || body.path.trim() === '' || body.path.includes('..')) {
        return reply.status(422).send({ message: 'File path and text content are required; path traversal is not allowed.' });
      }
      const projectExists = await store.read((state) => state.projects.some((project) => project.id === request.params.projectId && project.tenantId === scope.tenantId));
      if (!projectExists) return reply.status(404).send({ message: 'Project not found.' });
      const file: ProjectFileRecord = {
        tenantId: scope.tenantId,
        projectId: request.params.projectId,
        path: body.path,
        content: body.content,
        sha256: createHash('sha256').update(body.content).digest('hex'),
        updatedAt: new Date().toISOString(),
      };
      await store.mutate((state) => {
        const index = state.files.findIndex((candidate) => candidate.projectId === file.projectId && candidate.tenantId === file.tenantId && candidate.path === file.path);
        if (index < 0) state.files.push(file); else state.files[index] = file;
      });
      return file;
    },
  );

  app.patch<{ Params: { projectId: string }; Body: unknown }>('/api/projects/:projectId/files', async (request, reply) => {
    const scope = scopeFromRequest(request);
    const body = request.body as { path?: unknown; newPath?: unknown };
    if (typeof body?.path !== 'string' || typeof body.newPath !== 'string' || body.path.includes('..') || body.newPath.includes('..') || body.newPath.trim() === '') return reply.status(422).send({ message: 'path and newPath are required; traversal is not allowed.' });
    const oldPath = body.path;
    const newPath = body.newPath;
    const renamed = await store.mutate((state) => {
      const file = state.files.find((candidate) => candidate.projectId === request.params.projectId && candidate.tenantId === scope.tenantId && candidate.path === oldPath);
      if (file === undefined) return false;
      if (state.files.some((candidate) => candidate.projectId === request.params.projectId && candidate.tenantId === scope.tenantId && candidate.path === newPath)) throw new Error('A file already exists at the destination path.');
      file.path = newPath;
      file.updatedAt = new Date().toISOString();
      return true;
    });
    if (!renamed) return reply.status(404).send({ message: 'Project file not found.' });
    return { renamed: true, path: oldPath, newPath };
  });

  app.delete<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/files',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { path?: unknown };
      if (typeof body?.path !== 'string' || body.path.trim() === '') return reply.status(422).send({ message: 'File path is required.' });
      const removed = await store.mutate((state) => {
        const before = state.files.length;
        state.files = state.files.filter((file) => !(file.projectId === request.params.projectId && file.tenantId === scope.tenantId && file.path === body.path));
        return state.files.length !== before;
      });
      if (!removed) return reply.status(404).send({ message: 'Project file not found.' });
      return { deleted: true, path: body.path };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    '/api/projects/:projectId/compile',
    async (request, reply) => {
      const scope = scopeFromRequest(request);
      const body = request.body as { environment?: unknown };
      const environment = typeof body?.environment === 'string' && body.environment.trim() !== '' ? body.environment : 'local';
      const files = await store.read((state) => state.files.filter((file) => file.projectId === request.params.projectId && file.tenantId === scope.tenantId));
      try {
        const compiled = compileResourceFiles(files.map((file) => ({ path: file.path, source: file.content })), { tenantId: scope.tenantId, projectId: request.params.projectId });
        const sources = files.map((file) => ({ path: file.path, sha256: file.sha256 }));
        const digest = createHash('sha256').update(JSON.stringify({ environment, sources, workflows: compiled.workflows })).digest('hex');
        const artifact: ArtifactRecord = { tenantId: scope.tenantId, projectId: request.params.projectId, id: `sha256:${digest}`, environment, compilerVersion: '0.1.0', sources, workflows: compiled.workflows, createdAt: new Date().toISOString() };
        await store.mutate((state) => {
          if (!state.artifacts.some((candidate) => candidate.id === artifact.id && candidate.projectId === artifact.projectId && candidate.tenantId === artifact.tenantId)) state.artifacts.push(artifact);
        });
        return artifact;
      } catch (error) {
        return reply.status(422).send({ message: errorMessage(error) });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/artifacts', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.artifacts.filter((artifact) => artifact.projectId === request.params.projectId && artifact.tenantId === scope.tenantId)) };
  });

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
      const body = request.body as { artifactId?: unknown };
      const selected = await store.read((state) => {
        const artifactId = typeof body?.artifactId === 'string' ? body.artifactId : undefined;
        const artifact = artifactId === undefined ? undefined : state.artifacts.find((candidate) => candidate.id === artifactId && inScope(candidate, scope));
        const workflow = state.workflows.find((candidate) => candidate.id === request.params.id && inScope(candidate, scope));
        const pinned = artifact?.workflows.find((candidate) => candidate.id === request.params.id);
        return { workflow: pinned ?? workflow, artifactId: artifact?.id };
      });
      const workflow = selected.workflow;
      if (workflow === undefined) {
        return reply.status(404).send({ message: 'Workflow not found.' });
      }
      try {
        return await executor.start(workflow, selected.artifactId === undefined ? {} : { artifactId: selected.artifactId });
      } catch (error) {
        return reply.status(422).send({ message: errorMessage(error) });
      }
    },
  );

  app.get('/api/runs', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: await store.read((state) => state.runs.filter((run) => inScope(run, scope))) };
  });

  app.get('/api/deployments', async (request) => {
    return { items: await deployments.list(scopeFromRequest(request)) };
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
    const body = request.body as { action?: unknown; artifactId?: unknown; reason?: unknown };
    const actions = new Set(['deploy', 'start', 'stop', 'restart', 'rollback']);
    if (typeof body?.action !== 'string' || !actions.has(body.action)) return reply.status(422).send({ message: 'A supported deployment action is required.' });
    try {
      return await deployments.action(request.params.id, scopeFromRequest(request), body.action as import('../domain/types.js').DeploymentAction, {
        ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
    } catch (error) {
      return reply.status(409).send({ message: errorMessage(error) });
    }
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
        return await executor.approve(request.params.id, {
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
        return await executor.deny(request.params.id, {
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
        return await executor.cancel(request.params.id);
      } catch (error) {
        return reply.status(409).send({ message: errorMessage(error) });
      }
    },
  );

  app.get<{ Querystring: { runId?: string } }>('/api/events', async (request) => {
    const scope = scopeFromRequest(request);
    return { items: (await events.list(request.query.runId)).filter((event) => inScope(event, scope)) };
  });

  app.get<{ Querystring: { runId?: string; tenantId?: string; projectId?: string; unitId?: string; operation?: string; status?: import('../domain/types.js').OperationEvidenceStatus; from?: string; to?: string } }>('/api/evidence', async (request) => {
    const scope = scopeFromRequest(request);
    return {
      items: (await events.listEvidence({
        ...(request.query.runId === undefined ? {} : { runId: request.query.runId }),
        ...(request.query.tenantId === undefined ? {} : { tenantId: request.query.tenantId }),
        ...(request.query.projectId === undefined ? {} : { projectId: request.query.projectId }),
        ...(request.query.unitId === undefined ? {} : { unitId: request.query.unitId }),
        ...(request.query.operation === undefined ? {} : { operation: request.query.operation }),
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
        ...(request.query.from === undefined ? {} : { from: request.query.from }),
        ...(request.query.to === undefined ? {} : { to: request.query.to }),
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
  await executor.recover();
  return app;
}
