import { parseDocument } from 'yaml';
import { z } from 'zod';

import { parseProjectYaml } from './yaml.js';
import { workUnitSchema } from '../domain/schema.js';
import type { ProjectRecord, SourceDiagnostic, WorkflowDefinition } from '../domain/types.js';

export const resourceEnvelopeSchema = z.object({
  apiVersion: z.literal('factory.agentic/v1'),
  kind: z.enum(['Project', 'Workflow', 'Agent', 'WorkUnit', 'Policy', 'Connection', 'Environment', 'Schema', 'Canvas']),
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
    inputSchema: z.union([z.record(z.string(), z.unknown()), z.string().min(1)]).optional(),
    outputSchema: z.union([z.record(z.string(), z.unknown()), z.string().min(1)]).optional(),
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
    inputSchema: z.union([z.record(z.string(), z.unknown()), z.string().min(1)]).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).min(1),
  }).passthrough(),
  WorkUnit: workUnitSchema,
  Policy: z.object({
    rules: z.array(z.record(z.string(), z.unknown())).optional(),
  }).passthrough(),
  Connection: z.object({
    connector: z.string().min(1),
    environment: z.string().min(1),
    scopes: z.array(z.string().min(1)).max(100).optional(),
    secretRef: z.string().min(1).optional(),
  }).passthrough(),
  Environment: z.object({
    name: z.string().min(1),
    overrides: z.record(z.string(), z.unknown()).optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  // JSON Schema documents are intentionally permissive beyond their optional
  // type field so schemas can use draft-specific keywords without a runtime
  // compiler release for every keyword.
  Schema: z.object({ type: z.string().min(1).optional() }).passthrough(),
  Canvas: z.object({
    workflowId: z.string().min(1),
    nodes: z.array(z.object({
      id: z.string().min(1),
      position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    }).passthrough()).optional(),
    edges: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) }).passthrough()).optional(),
  }).passthrough(),
};

export interface ResourceFile { path: string; source: string }

export interface CompiledResourceFiles {
  project: ProjectRecord;
  workflows: WorkflowDefinition[];
  resources: Array<z.infer<typeof resourceEnvelopeSchema>>;
}

export class ResourceCompilationError extends Error {
  public readonly diagnostics: SourceDiagnostic[];

  public constructor(message: string, diagnostics: SourceDiagnostic[]) {
    super(message);
    this.name = 'ResourceCompilationError';
    this.diagnostics = diagnostics;
  }
}

const forbiddenMetadata = new Set(['createdAt', 'updatedAt', 'status', 'deployment', 'runState']);

const resourcePathPatterns: Record<z.infer<typeof resourceEnvelopeSchema>['kind'], RegExp> = {
  Project: /^factory\.ya?ml$/,
  Workflow: /^workflows\/[^/]+\.workflow\.ya?ml$/,
  Agent: /^agents\/[^/]+\.agent\.ya?ml$/,
  WorkUnit: /^units\/[^/]+\.unit\.ya?ml$/,
  Policy: /^policies\/[^/]+\.policy\.ya?ml$/,
  Connection: /^connections\/[^/]+\.connection\.ya?ml$/,
  Environment: /^environments\/[^/]+\.environment\.ya?ml$/,
  Schema: /^schemas\/[^/]+\.schema\.json$/,
  Canvas: /^canvas\/[^/]+\.canvas\.ya?ml$/,
};

function assertResourcePath(resource: ResourceFile, kind: z.infer<typeof resourceEnvelopeSchema>['kind']): void {
  if (!resourcePathPatterns[kind].test(resource.path)) {
    throw new Error(`${resource.path}: resource kind ${kind} must use its conventional file path.`);
  }
}

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

function diagnosticForError(error: unknown, fallbackPath: string): SourceDiagnostic {
  const message = error instanceof Error ? error.message : 'resource compilation failed';
  const match = /^(.*?):(\d+)(?::(\d+))?:\s*(.*)$/.exec(message);
  if (match !== null) {
    return {
      severity: 'error',
      path: match[1] || fallbackPath,
      line: Number(match[2]) || 1,
      column: Number(match[3]) || 1,
      code: 'resource.compile',
      message: match[4] || message,
    };
  }
  return { severity: 'error', path: fallbackPath, line: 1, column: 1, code: 'resource.compile', message };
}

function resourcePathForError(resources: ResourceFile[], message: string): string {
  const explicitPath = /^(.*?):\d+(?::\d+)?:/.exec(message)?.[1];
  if (explicitPath !== undefined && resources.some((resource) => resource.path === explicitPath)) return explicitPath;
  return resources.find((resource) => resource.path === 'factory.yaml' || resource.path === 'factory.yml')?.path
    ?? resources[0]?.path
    ?? 'factory.yaml';
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
export function compileResourceFiles(resources: ResourceFile[], scope: { tenantId: string; projectId?: string; environment?: string }): CompiledResourceFiles {
  try {
    return compileResourceFilesInternal(resources, scope);
  } catch (error) {
    if (error instanceof ResourceCompilationError) throw error;
    const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(diagnostics)) throw new ResourceCompilationError(error instanceof Error ? error.message : 'resource compilation failed', diagnostics as SourceDiagnostic[]);
    const message = error instanceof Error ? error.message : 'resource compilation failed';
    throw new ResourceCompilationError(message, [diagnosticForError(error, resourcePathForError(resources, message))]);
  }
}

function compileResourceFilesInternal(resources: ResourceFile[], scope: { tenantId: string; projectId?: string; environment?: string }): CompiledResourceFiles {
  const parseFailures: Array<{ resource: ResourceFile; error: unknown }> = [];
  const envelopes: Array<z.infer<typeof resourceEnvelopeSchema>> = [];
  for (const resource of resources) {
    try {
      envelopes.push(parseResourceFile(resource));
    } catch (error) {
      parseFailures.push({ resource, error });
    }
  }
  if (parseFailures.length > 0) {
    const diagnostics = parseFailures.map(({ resource, error }) => diagnosticForError(error, resource.path));
    throw new ResourceCompilationError(
      `${diagnostics.length} resource file${diagnostics.length === 1 ? '' : 's'} failed validation.`,
      diagnostics,
    );
  }
  envelopes.forEach((resource, index) => {
    const source = resources[index];
    if (source !== undefined) assertResourcePath(source, resource.kind);
  });
  const seen = new Set<string>();
  envelopes.forEach((resource, index) => {
    const identity = `${resource.kind}/${resource.metadata.id}`;
    if (seen.has(identity)) throw new Error(`${resources[index]?.path ?? 'resource'}:1: duplicate resource identity ${identity}`);
    seen.add(identity);
  });
  const projectResources = envelopes.filter((resource) => resource.kind === 'Project');
  if (projectResources.length !== 1) throw new Error(`Resource workspace must contain exactly one Project resource; found ${projectResources.length}.`);
  const projectResource = projectResources[0];
  if (projectResource === undefined) throw new Error('Resource workspace must contain one Project resource.');
  const projectSpec = projectResource.spec;
  const selectedEnvironmentName = scope.environment?.trim() || 'local';
  const selectedEnvironment = envelopes.find((resource) => resource.kind === 'Environment' && (
    resource.metadata.id === selectedEnvironmentName || resource.spec.name === selectedEnvironmentName
  ));
  const projectDefaults = projectSpec.defaults !== null && typeof projectSpec.defaults === 'object' ? projectSpec.defaults as Record<string, unknown> : {};
  const environmentOverrides = selectedEnvironment?.spec.overrides !== null && typeof selectedEnvironment?.spec.overrides === 'object'
    ? selectedEnvironment.spec.overrides as Record<string, unknown>
    : {};
  const merge = (base: Record<string, unknown>, ...layers: unknown[]): Record<string, unknown> => {
    const result = structuredClone(base);
    for (const layer of layers) {
      if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) continue;
      for (const [key, value] of Object.entries(layer as Record<string, unknown>)) {
        const current = result[key];
        result[key] = current !== null && typeof current === 'object' && !Array.isArray(current) && value !== null && typeof value === 'object' && !Array.isArray(value)
          ? merge(current as Record<string, unknown>, value)
          : structuredClone(value);
      }
    }
    return result;
  };
  const overrideFor = (kind: string, id: string): unknown[] => {
    const plural = `${kind.toLowerCase()}s`;
    return [
      projectDefaults[plural] !== null && typeof projectDefaults[plural] === 'object' ? (projectDefaults[plural] as Record<string, unknown>)[id] : undefined,
      projectDefaults[`${kind}/${id}`],
      environmentOverrides[plural] !== null && typeof environmentOverrides[plural] === 'object' ? (environmentOverrides[plural] as Record<string, unknown>)[id] : undefined,
      environmentOverrides[`${kind}/${id}`],
    ];
  };
  const schemas = new Map(envelopes.filter((resource) => resource.kind === 'Schema').map((resource) => [resource.metadata.id, resource.spec]));
  const resolveSchema = (value: unknown, owner: string): unknown => {
    if (typeof value === 'string') {
      const reference = value.startsWith('$ref:') ? value.slice('$ref:'.length) : undefined;
      if (reference === undefined) return value;
      const id = reference.startsWith('Schema/') ? reference.slice('Schema/'.length) : reference;
      const schema = schemas.get(id);
      if (schema === undefined) throw new Error(`${owner} references missing Schema/${id}.`);
      return structuredClone(schema);
    }
    if (Array.isArray(value)) return value.map((item) => resolveSchema(item, owner));
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === 'string') {
        const id = object.$ref.startsWith('Schema/') ? object.$ref.slice('Schema/'.length) : object.$ref;
        const schema = schemas.get(id);
        if (schema === undefined) throw new Error(`${owner} references missing Schema/${id}.`);
        const { $ref: _ref, ...overrides } = object;
        return { ...(structuredClone(schema) as Record<string, unknown>), ...(resolveSchema(overrides, owner) as Record<string, unknown>) };
      }
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolveSchema(child, owner)]));
    }
    return value;
  };
  const agents = envelopes.filter((resource) => resource.kind === 'Agent').map((resource) => ({
    ...(resolveSchema(merge({}, ...overrideFor('Agent', resource.metadata.id), resource.spec), `Agent/${resource.metadata.id}`) as Record<string, unknown>),
    id: resource.metadata.id,
    ...(resource.metadata.version === undefined ? {} : { version: resource.metadata.version }),
    ...(resource.metadata.name === undefined ? {} : { name: resource.metadata.name }),
  }));
  const workUnits = new Map(envelopes.filter((resource) => resource.kind === 'WorkUnit').map((resource) => [resource.metadata.id, resource.spec]));
  const workUnitIds = new Set(workUnits.keys());
  const agentIds = new Set(envelopes.filter((resource) => resource.kind === 'Agent').map((resource) => resource.metadata.id));
  const policyIds = new Set(envelopes.filter((resource) => resource.kind === 'Policy').map((resource) => resource.metadata.id));
  const connectionIds = new Set(envelopes.filter((resource) => resource.kind === 'Connection').map((resource) => resource.metadata.id));
  const resolveReference = (value: string, kind: string, ids: Set<string>): string | undefined => {
    const id = value.startsWith(`${kind}/`) ? value.slice(kind.length + 1) : value;
    return ids.has(id) ? id : undefined;
  };
  const workflows = envelopes.filter((resource) => resource.kind === 'Workflow').map((resource) => ({
    ...merge({}, ...overrideFor('Workflow', resource.metadata.id), resource.spec),
    id: resource.metadata.id,
    ...(resource.metadata.version === undefined ? {} : { version: resource.metadata.version }),
    ...(resource.metadata.name === undefined ? {} : { name: resource.metadata.name }),
    ...((merge({}, ...overrideFor('Workflow', resource.metadata.id), resource.spec).inputSchema === undefined ? {} : { inputSchema: resolveSchema(merge({}, ...overrideFor('Workflow', resource.metadata.id), resource.spec).inputSchema, `Workflow/${resource.metadata.id}`) })),
    steps: (merge({}, ...overrideFor('Workflow', resource.metadata.id), resource.spec).steps as Array<Record<string, unknown>>).map((step, stepIndex) => {
      let resolved = { ...step };
      if (typeof step.unit === 'string') {
        const unitId = resolveReference(step.unit, 'WorkUnit', workUnitIds);
        if (unitId === undefined) throw new Error(`Workflow ${resource.metadata.id} step ${String(step.id ?? stepIndex + 1)} references missing WorkUnit/${step.unit}.`);
        const unit = workUnits.get(unitId);
        if (unit === undefined) throw new Error(`Workflow references missing WorkUnit/${step.unit}.`);
        resolved = { ...resolved, unit };
      }
      if (typeof step.agent === 'string' && resolveReference(step.agent, 'Agent', agentIds) === undefined) throw new Error(`Workflow ${resource.metadata.id} step ${String(step.id ?? stepIndex + 1)} references missing Agent/${step.agent}.`);
      if (typeof step.policy === 'string') {
        const policyId = resolveReference(step.policy, 'Policy', policyIds);
        if (policyId === undefined) throw new Error(`Workflow ${resource.metadata.id} step ${String(step.id ?? stepIndex + 1)} references missing Policy/${step.policy}.`);
        const policy = envelopes.find((candidate) => candidate.kind === 'Policy' && candidate.metadata.id === policyId);
        resolved.config = {
          ...(resolved.config as Record<string, unknown> | undefined),
          policyId,
          ...(policy === undefined || !Array.isArray(policy.spec.rules) ? {} : { policyRules: structuredClone(policy.spec.rules) }),
        };
      }
      if (typeof step.connection === 'string') {
        const connectionId = resolveReference(step.connection, 'Connection', connectionIds);
        if (connectionId === undefined) throw new Error(`Workflow ${resource.metadata.id} step ${String(step.id ?? stepIndex + 1)} references missing Connection/${step.connection}.`);
        resolved.config = { ...(resolved.config as Record<string, unknown> | undefined), connectionId };
      }
      return resolved;
    }),
  }));
  for (const resource of envelopes.filter((candidate) => candidate.kind === 'Workflow')) {
    const steps = resource.spec.steps as Array<Record<string, unknown>>;
    const stepId = (step: Record<string, unknown>, index: number): string => typeof step.id === 'string' ? step.id : `${String(step.kind ?? step.type ?? 'step')}-${index + 1}`;
    const ids = new Set(steps.map(stepId));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, chain: string[]): void => {
      if (visiting.has(id)) throw new Error(`Workflow ${resource.metadata.id} has a reference cycle: ${[...chain, id].join(' -> ')}.`);
      if (visited.has(id)) return;
      visiting.add(id);
      const index = steps.findIndex((step, candidateIndex) => stepId(step, candidateIndex) === id);
      const dependencies = index < 0 ? undefined : steps[index]?.dependsOn;
      if (Array.isArray(dependencies)) {
        for (const dependency of dependencies) {
          if (typeof dependency !== 'string') continue;
          if (!ids.has(dependency)) throw new Error(`Workflow ${resource.metadata.id} step ${id} references missing step ${dependency}.`);
          visit(dependency, [...chain, id]);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id, []);
  }
  for (const resource of envelopes.filter((candidate) => candidate.kind === 'Canvas')) {
    const workflowId = (resource.spec as { workflowId: string }).workflowId;
    if (resolveReference(workflowId, 'Workflow', new Set(workflows.map((workflow) => workflow.id))) === undefined) throw new Error(`Canvas/${resource.metadata.id} references missing Workflow/${workflowId}.`);
  }
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
    const workflowById = new Map(compiled.workflows.map((workflow) => [workflow.id, workflow]));
    for (const canvas of envelopes.filter((candidate) => candidate.kind === 'Canvas')) {
      const workflowId = (canvas.spec as { workflowId: string }).workflowId.replace(/^Workflow\//, '');
      const workflow = workflowById.get(workflowId);
      if (workflow === undefined) continue;
      const positions = new Map(((canvas.spec as { nodes?: Array<{ id: string; position: { x: number; y: number } }> }).nodes ?? []).map((node) => [node.id, node.position]));
      for (const node of workflow.nodes) {
        const position = positions.get(node.id);
        if (position !== undefined) node.position = { ...position };
      }
    }
    return { ...compiled, resources: envelopes };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'resource compilation failed';
    // Preserve the authored file as the diagnostic anchor while the aggregate
    // compiler is still the compatibility path for legacy project documents.
    const sourcePath = resources.find((resource) => resource.path.includes('.workflow.') || resource.path.endsWith('workflow.yaml'))?.path
      ?? resources.find((resource) => resource.path.includes('.agent.') || resource.path.endsWith('agent.yaml'))?.path
      ?? resources.find((resource) => resource.path === 'factory.yaml' || resource.path === 'factory.yml')?.path
      ?? 'project.yaml';
    throw new Error(`${sourcePath}: ${message}`);
  }
}
