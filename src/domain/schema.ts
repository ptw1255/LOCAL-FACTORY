import { z } from 'zod';

const configSchema = z.record(z.string(), z.unknown());

export const workUnitSchema = z.object({
  kind: z.enum(['deterministic', 'agent', 'human', 'connector', 'consumer', 'evaluator']),
  version: z.number().int().positive(),
  inputSchema: z.string().min(1),
  outputSchema: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  retryAttempts: z.number().int().min(1).max(10),
  idempotencyKey: z.string().min(1).optional(),
});

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  purpose: z.string().min(1),
  instructions: z.string().min(1),
  skills: z.array(z.string().min(1)).max(100),
  tools: z.array(z.string().min(1)).max(100),
  model: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    routingAlias: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    secretRef: z.string().min(1).optional(),
    streaming: z.boolean().optional(),
    pricing: z.object({ promptPer1kUsd: z.number().nonnegative(), completionPer1kUsd: z.number().nonnegative() }).optional(),
    provisioning: z.object({
      mode: z.enum(['never', 'pull-on-start', 'baked']).default('never'),
      digest: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    }).optional(),
    routes: z.array(z.object({
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1).optional(),
      endpoint: z.url().optional(),
      secretRef: z.string().trim().min(1).optional(),
    })).max(8).optional(),
    routing: z.object({
      strategy: z.enum(['single', 'fallback']),
      maxAttempts: z.number().int().positive().max(8).optional(),
    }).optional(),
  }),
  inputSchema: configSchema,
  outputSchema: configSchema,
  boundaries: z.object({
    allowedConnections: z.array(z.string()),
    allowedRepositories: z.array(z.string()),
    protectedPaths: z.array(z.string()),
    network: z.enum(['deny-by-default', 'allow-listed']),
    dataClasses: z.array(z.string()),
  }),
  limits: z.object({
    maxIterations: z.number().int().min(1).max(25),
    maxCostUsd: z.number().nonnegative(),
    maxDurationMs: z.number().int().positive(),
    maxTokens: z.number().int().positive().optional(),
  }),
  termination: z.object({
    successConditions: z.array(z.string().min(1)).min(1),
    failureConditions: z.array(z.string().min(1)),
    escalationConditions: z.array(z.string().min(1)),
  }),
  approval: z.object({
    beforeSideEffects: z.boolean(),
    beforeTools: z.array(z.string()),
  }),
  observability: z.object({
    captureInputs: z.boolean(),
    captureOutputs: z.boolean(),
    redactedFields: z.array(z.string()),
  }),
});

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  config: configSchema,
  unit: workUnitSchema.optional(),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  condition: z.string().optional(),
});

export const workflowDefinitionSchema = z.object({
  tenantId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'deployed']),
  trigger: z.object({
    type: z.string().min(1),
  }),
  agents: z.array(agentDefinitionSchema),
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  connector: z.string().trim().min(1).max(100),
  environment: z.string().trim().min(1).max(50),
  scopes: z.array(z.string().trim().min(1)).max(25),
  secret: z.string().min(1).max(10_000).optional(),
});

export const createProposalSchema = z.object({
  goal: z.string().trim().min(10).max(2_000),
  workflowId: z.string().min(1),
});

export const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const createProjectSchema = z.object({
  tenantId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
});

export const cloneWorkflowSchema = z.object({
  sourceWorkflowId: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
});

export const declarativeImportSchema = z.object({
  source: z.string().min(1).max(1_000_000),
});
