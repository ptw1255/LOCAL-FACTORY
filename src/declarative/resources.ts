import { parse } from 'yaml';
import { z } from 'zod';

import { parseProjectYaml } from './yaml.js';
import type { ProjectRecord, WorkflowDefinition } from '../domain/types.js';

export const resourceEnvelopeSchema = z.object({
  apiVersion: z.literal('factory.agentic/v1'),
  kind: z.enum(['Project', 'Workflow', 'Agent', 'WorkUnit']),
  metadata: z.object({
    id: z.string().min(1),
    version: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
  }).passthrough(),
  spec: z.record(z.string(), z.unknown()),
});

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
    if (/secret|api.?key|token|credential/i.test(key) && typeof child === 'string') {
      throw new Error(`${path}.${key} must be a secret reference, not a secret value.`);
    }
    assertNoRuntimeMetadata(child, `${path}.${key}`);
  }
}

export function parseResourceFile(resource: ResourceFile): z.infer<typeof resourceEnvelopeSchema> {
  let parsed: unknown;
  try { parsed = parse(resource.source); } catch (error) {
    throw new Error(`${resource.path}: invalid YAML (${error instanceof Error ? error.message : 'parse error'})`);
  }
  assertNoRuntimeMetadata(parsed, resource.path);
  const result = resourceEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${resource.path}: ${result.error.issues.map((issue) => `${issue.path.join('.') || 'document'} ${issue.message}`).join('; ')}`);
  }
  return result.data;
}

/** Compiles one project entrypoint plus typed Agent/Workflow resource files. */
export function compileResourceFiles(resources: ResourceFile[], scope: { tenantId: string; projectId?: string }): CompiledResourceFiles {
  const envelopes = resources.map(parseResourceFile);
  const projectResource = envelopes.find((resource) => resource.kind === 'Project');
  if (projectResource === undefined) throw new Error('Resource workspace must contain one Project resource.');
  const projectSpec = projectResource.spec;
  const agents = envelopes.filter((resource) => resource.kind === 'Agent').map((resource) => ({
    ...(resource.spec as Record<string, unknown>),
    id: resource.metadata.id,
    ...(resource.metadata.version === undefined ? {} : { version: resource.metadata.version }),
    ...(resource.metadata.name === undefined ? {} : { name: resource.metadata.name }),
  }));
  const workflows = envelopes.filter((resource) => resource.kind === 'Workflow').map((resource) => ({
    ...(resource.spec as Record<string, unknown>),
    id: resource.metadata.id,
    ...(resource.metadata.version === undefined ? {} : { version: resource.metadata.version }),
    ...(resource.metadata.name === undefined ? {} : { name: resource.metadata.name }),
  }));
  const source = {
    apiVersion: 'factory.agentic/v1', kind: 'Project',
    metadata: { id: projectResource.metadata.id, name: projectResource.metadata.name ?? projectResource.metadata.id, description: typeof projectSpec.description === 'string' ? projectSpec.description : '' },
    agents,
    workflows,
  };
  try {
    return parseProjectYaml(JSON.stringify(source), scope);
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
