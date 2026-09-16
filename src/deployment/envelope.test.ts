import { describe, expect, it } from 'vitest';

import { seedWorkflow } from '../domain/seed.js';
import { deploymentEnvelopeSchema, toDeploymentEnvelope } from './envelope.js';

describe('deployment envelope', () => {
  it('projects runtime records into the lean desired/status contract', () => {
    const envelope = toDeploymentEnvelope({
      id: 'deployment-1', tenantId: 'tenant-local', projectId: 'project-local', workflowId: seedWorkflow.id,
      environment: 'local', artifactId: 'sha256:artifact', desiredState: 'running', observedState: 'starting',
      health: 'unknown', trigger: 'manual', triggerStatus: 'inactive', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z', healthyArtifactIds: [], history: [],
    });
    expect(envelope).not.toHaveProperty('history');
    expect(deploymentEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.spec.desiredState).toBe('live');
  });
});
