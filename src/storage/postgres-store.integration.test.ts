import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PostgresStore } from './postgres-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('PostgresStore integration', () => {
  it('persists scoped telemetry and evidence across a store restart', async () => {
    const tenantId = `integration-${randomUUID()}`;
    const projectId = 'project-local';
    const runId = `run-${randomUUID()}`;
    const eventId = randomUUID();
    const evidenceId = randomUUID();
    const first = new PostgresStore(databaseUrl!);
    await first.appendEvent({
      id: eventId,
      tenantId,
      projectId,
      runId,
      type: 'integration.test',
      timestamp: new Date().toISOString(),
      message: 'PostgreSQL integration probe.',
      signal: 'log',
      severityText: 'INFO',
      traceId: runId.replaceAll('-', '').padEnd(32, '0').slice(0, 32),
      spanId: eventId.replaceAll('-', '').slice(0, 16),
    });
    await first.appendEvidence({
      id: evidenceId,
      tenantId,
      projectId,
      deploymentId: `deployment-${randomUUID()}`,
      runId,
      unitId: 'integration',
      operation: 'integration.test',
      attempt: 1,
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
      correlationId: runId,
      metadata: { 'integration.kind': 'postgres' },
    });
    await first.close();

    const reopened = new PostgresStore(databaseUrl!);
    try {
      await expect(reopened.listEvents(runId)).resolves.toEqual([expect.objectContaining({ id: eventId, tenantId, projectId })]);
      await expect(reopened.listEvidence({ tenantId, projectId, runId })).resolves.toEqual([expect.objectContaining({ id: evidenceId, tenantId, projectId, operation: 'integration.test' })]);
    } finally {
      await reopened.close();
    }
  });
});
