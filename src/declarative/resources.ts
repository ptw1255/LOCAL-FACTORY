import { parseDocument } from 'yaml';
import { z } from 'zod';

import { parseProjectYaml } from './yaml.js';
import { workUnitSchema } from '../domain/schema.js';
import type { ProjectRecord, WorkflowDefinition } from '../domain/types.js';

export const resourceEnvelopeSchema = z.object({
  apiVersion: z.literal('factory.agentic/v1'),
  kind: z.enum(['Project', 'Workflow', 'Agent', 'WorkUnit']),
  metadata: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    name: z.string().min(1).optional(),
  }).passthrough(),
  spec: z.record(z.string(), z.unknown()),
});

/** Kind-specific desired configuration. These intentionally validate the
 * authored shape without duplicating the richer runtime defaults. */
const kindSpecSchemas: Record<z.infer<typeof resourceEnvelopeSchema>['kind'], z.ZodTypeAny> = {
  Project: z.object({ description: z.string().optional() }).passthrough(),
  Agent: z.object({
    purpose: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).max(100).optional(),
    tools: z.array(z.string().min(1)).max(100).optional(),
    model: z.record(z.string(), z.unknown()).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    boundaries: z.record(z.string(), z.unknown()).optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
    termination: z.record(z.string(), z.unknown()).optional(),
    approval: z.record(z.string(), z.unknown()).optional(),
    observability: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  Workflow: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    version: z.number().int().positive().optional(),
    trigger: z.string().min(1).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).min(1),
  }).passthrough(),
  WorkUnit: workUnitSchema,
};

export interface ResourceFile { path: string; source: string }

export interface CompiledResourceFiles {
  project: ProjectRecord;
  workflows: WorkflowDefinition[];
}

const forbiddenMetadata = new Set(['createdAt', 'updatedAt', 'status', 'deployment', 'runState']);

function assertNoRuntimeMetadata(value: unknown, path = 'document'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRuntimeMetadata(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenMetadata.has(key)) throw new Error(`${path}.${key} is runtime state and cannot be authored.`);
    if (key !== 'secretRef' && /secret|api.?key|token|credential/i.test(key) && typeof child === 'string') {
      throw new Error(`${path}.${key} must be a secret reference, not a secret value.`);
    }
    assertNoRuntimeMetadata(child, `${path}.${key}`);
  }
}

function lineForKey(source: string, key: string): number {
  const index = source.split(/\r?\n/).findIndex((line) => new RegExp(`(?:^|\\s)${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}:`).test(line));
  return index < 0 ? 1 : index + 1;
}

function lineForListId(source: string, id: string, fallback: number): number {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = source.split(/\r?\n/).findIndex((candidate) => new RegExp(`^\\s*-\\s+id:\\s*['\"]?${escaped}['\"]?\\s*$`).test(candidate));
  return line < 0 ? fallback : line + 1;
}

export function parseResourceFile(resource: ResourceFile): z.infer<typeof resourceEnvelopeSchema> {
  const document = parseDocument(resource.source);
  if (document.errors.length > 0) {
    const error = document.errors[0];
    const line = error?.pos?.[0] === undefined ? 1 : resource.source.slice(0, error.pos[0]).split(/\r?\n/).length;
    throw new Error(`${resource.path}:${line}: invalid YAML (${error?.message ?? 'parse error'})`);
  }
  const parsed = document.toJS() as unknown;
  try { assertNoRuntimeMetadata(parsed, resource.path); } catch (error) {
    const message = error instanceof Error ? error.message : 'runtime metadata is not allowed';
    const key = message.split('.').at(-1)?.replace(/ .*/, '') ?? '';
    throw new Error(`${resource.path}:${lineForKey(resource.source, key)}: ${message}`);
  }
  const result = resourceEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${resource.path}:${lineForKey(resource.source, String(result.error.issues[0]?.path.at(-1) ?? 'document'))}: ${result.error.issues.map((issue) => `${issue.path.join('.') || 'document'} ${issue.message}`).join('; ')}`);
  }
  const specResult = kindSpecSchemas[result.data.kind].safeParse(result.data.spec);
  if (!specResult.success) {
    const issue = specResult.error.issues[0];
    const field = String(issue?.path.join('.') || 'spec');
    throw new Error(`${resource.path}:${lineForKey(resource.source, field.split('.').at(-1) ?? 'spec')}: spec.${field} ${issue?.message ?? 'is invalid'}`);
  }
  return result.data;
}

/** Compiles one project entrypoint plus typed Agent/Workflow resource files. */
export function compileResourceFiles(resources: ResourceFile[], scope: { tenantId: string; projectId?: string }): CompiledResourceFiles {
  const envelopes = resources.map(parseResourceFile);
  const seen = new Set<string>();
  envelopes.forEach((resource, index) => {
    const identity = `${resource.kind}/${resource.metadata.id}`;
    if (seen.has(identity)) throw new Error(`${resources[index]?.path ?? 'resource'}:1: duplicate resource identity ${identity}`);
    seen.add(identity);
  });
  const projectResource = envelopes.find((resource) => resource.kind === 'Project');
  if (projectResource === undefined) throw new Error('Resource workspace must contain one Project resource.');
  const projectSpec = projectResource.spec;
  const agents = envelopes.filter((resource) => resource.kind === 'Agent').map((resource) => ({
    ...(resource.spec as Record<string, unknown>),
    id: resource.metadata.id,
    ...(resource.metadata.version === undefined ? {} : { version: resource.metadata.version }),
    ...(resource.metadata.name === undefined ? {} : { name: resource.metadata.name }),
  }));
  const workUnits = new Map(envelopes.filter((resource) => resource.kind === 'WorkUnit').map((resource) => [resource.metadata.id, resource.spec]));
  const workflows = envelopes.filter((resource) => resource.kind === 'Workflow').map((resource) => ({
    ...(resource.spec as Record<string, unknown>),
    id: resource.metadata.id,
    ...(resource.metadata.version === undefined ? {} : { version: resource.metadata.version }),
    ...(resource.metadata.name === undefined ? {} : { name: resource.metadata.name }),
    steps: (resource.spec.steps as Array<Record<string, unknown>>).map((step) => {
      if (typeof step.unit !== 'string') return step;
      const unit = workUnits.get(step.unit);
      if (unit === undefined) throw new Error(`Workflow references missing WorkUnit/${step.unit}.`);
      return { ...step, unit };
    }),
  }));
  const source = {
    apiVersion: 'factory.agentic/v1', kind: 'Project',
    metadata: { id: projectResource.metadata.id, name: projectResource.metadata.name ?? projectResource.metadata.id, description: typeof projectSpec.description === 'string' ? projectSpec.description : '' },
    agents,
    workflows,
  };
  try {
    const compiled = parseProjectYaml(JSON.stringify(source), scope);
    const workflowResources = new Map<string, { path: string; source: string }>();
    envelopes.forEach((resource, index) => {
      const sourceResource = resources[index];
      if (resource.kind === 'Workflow' && sourceResource !== undefined) workflowResources.set(resource.metadata.id, sourceResource);
    });
    for (const workflow of compiled.workflows) {
      const sourceResource = workflowResources.get(workflow.id);
      if (sourceResource === undefined) continue;
      const sourcePath = sourceResource.path;
      const fallbackLine = lineForKey(sourceResource.source, 'steps');
      for (const node of workflow.nodes) {
        node.sourcePath = sourcePath;
        node.sourceLine = lineForListId(sourceResource.source, node.id, fallbackLine);
      }
    }
    return compiled;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'resource compilation failed';
    // Preserve the authored file as the diagnostic anchor while the aggregate
    // compiler is still the compatibility path for legacy project documents.
    const sourcePath = resources.find((resource) => resource.path.includes('.workflow.') || resource.path.endsWith('workflow.yaml'))?.path
      ?? resources.find((resource) => resource.path.includes('.agent.') || resource.path.endsWith('agent.yaml'))?.path
      ?? resources.find((resource) => parseResourceFile(resource).kind === 'Project')?.path
      ?? 'project.yaml';
    throw new Error(`${sourcePath}: ${message}`);
  }
}
