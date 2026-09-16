import { z } from 'zod';

import type { DeploymentRecord } from '../domain/types.js';

export const deploymentEnvelopeSchema = z.object({
  apiVersion: z.literal('factory.agentic/v1'),
  kind: z.literal('Deployment'),
  metadata: z.object({ id: z.string().min(1), projectId: z.string().min(1) }),
  spec: z.object({
    workflowId: z.string().min(1),
    environment: z.string().min(1),
    artifactId: z.string().min(1),
    desiredState: z.enum(['live', 'stopped']),
  }).strict(),
  status: z.object({
    observedState: z.enum(['stopped', 'starting', 'live', 'degraded', 'stopping', 'failed']),
    updatedAt: z.iso.datetime(),
    error: z.string().nullable(),
  }),
});

export type DeploymentEnvelope = z.infer<typeof deploymentEnvelopeSchema>;

/** Public lean projection. Transition history stays in telemetry/evidence. */
export function toDeploymentEnvelope(deployment: DeploymentRecord): DeploymentEnvelope {
  return {
    apiVersion: 'factory.agentic/v1',
    kind: 'Deployment',
    metadata: { id: deployment.id, projectId: deployment.projectId },
    spec: {
      workflowId: deployment.workflowId,
      environment: deployment.environment,
      artifactId: deployment.artifactId,
      desiredState: deployment.desiredState === 'running' ? 'live' : 'stopped',
    },
    status: {
      observedState: deployment.observedState === 'unknown' ? 'stopped' : deployment.observedState,
      updatedAt: deployment.updatedAt,
      error: deployment.lastError ?? null,
    },
  };
}
