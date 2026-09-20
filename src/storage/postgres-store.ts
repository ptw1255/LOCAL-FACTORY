import { Pool, type PoolConfig } from 'pg';

import { createSeedState } from '../domain/seed.js';
import type { ArtifactRecord, EvidenceQuery, OperationEvidence, PlatformState, RunEvent } from '../domain/types.js';
import { normalizePlatformState, type EventListOptions, type PlatformStore, type StateMutation } from './store.js';

interface StateRow {
  state: PlatformState;
}

/**
 * PostgreSQL control-plane adapter.
 *
 * The MVP stores the canonical state document in one JSONB row so it has the
 * same behavior as JsonStore while gaining transactional, durable persistence.
 * Domain tables can be introduced behind this interface without changing callers.
 */
export class PostgresStore implements PlatformStore {
  private readonly pool: Pool;
  private initialized: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();

  public constructor(connectionString: string, config: Omit<PoolConfig, 'connectionString'> = {}) {
    this.pool = new Pool({ ...config, connectionString });
  }

  public async read<T>(select: (state: PlatformState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.load();
      return select(state);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return structuredClone(await operation);
  }

  public async mutate<T>(mutation: StateMutation<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      await this.ensureInitialized();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<StateRow>(
          'SELECT state FROM platform_state WHERE id = 1 FOR UPDATE',
        );
        const current = result.rows[0]?.state;
        if (current === undefined) throw new Error('PostgreSQL platform state is missing.');
        const draft = structuredClone(normalizePlatformState(current));
        const value = await mutation(draft);
        await client.query(
          'UPDATE platform_state SET state = $1::jsonb, updated_at = now() WHERE id = 1',
          [JSON.stringify(draft)],
        );
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return structuredClone(await operation);
  }

  public async mutateAndAppendEvent<T>(mutation: StateMutation<{ value: T; event?: RunEvent }>): Promise<{ value: T; eventAppended: boolean }> {
    const operation = this.queue.then(async () => {
      await this.ensureInitialized();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<StateRow>('SELECT state FROM platform_state WHERE id = 1 FOR UPDATE');
        const current = result.rows[0]?.state;
        if (current === undefined) throw new Error('PostgreSQL platform state is missing.');
        const draft = structuredClone(normalizePlatformState(current));
        const outcome = await mutation(draft);
        await client.query('UPDATE platform_state SET state = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(draft)]);
        if (outcome.event !== undefined) {
          await client.query(
            `INSERT INTO observability_events
              (id, tenant_id, project_id, run_id, timestamp, signal, event_type, trace_id, span_id,
               parent_span_id, span_kind, severity_text, node_id, event)
             VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
             ON CONFLICT (id) DO NOTHING`,
            [
              outcome.event.id,
              outcome.event.tenantId ?? null,
              outcome.event.projectId ?? null,
              outcome.event.runId,
              outcome.event.timestamp,
              outcome.event.signal,
              outcome.event.type,
              outcome.event.traceId,
              outcome.event.spanId,
              outcome.event.parentSpanId ?? null,
              outcome.event.spanKind ?? null,
              outcome.event.severityText ?? null,
              outcome.event.nodeId ?? null,
              JSON.stringify(outcome.event),
            ],
          );
        }
        await client.query('COMMIT');
        return { value: outcome.value, eventAppended: outcome.event !== undefined };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return structuredClone(await operation);
  }

  public async appendEvent(event: RunEvent): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query(
      `INSERT INTO observability_events
        (id, tenant_id, project_id, run_id, timestamp, signal, event_type, trace_id, span_id,
         parent_span_id, span_kind, severity_text, node_id, event)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.tenantId ?? null,
        event.projectId ?? null,
        event.runId,
        event.timestamp,
        event.signal,
        event.type,
        event.traceId,
        event.spanId,
        event.parentSpanId ?? null,
        event.spanKind ?? null,
        event.severityText ?? null,
        event.nodeId ?? null,
        JSON.stringify(event),
      ],
    );
  }

  public async listEvents(runId?: string, options: EventListOptions = {}): Promise<RunEvent[]> {
    await this.ensureInitialized();
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (runId !== undefined) { values.push(runId); clauses.push(`run_id = $${values.length}`); }
    if (options.before !== undefined) { values.push(options.before); clauses.push(`timestamp < $${values.length}::timestamptz`); }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.min(5_000, Math.floor(options.limit)));
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ event: RunEvent }>(
      `SELECT event FROM observability_events${where} ORDER BY timestamp DESC${limit === undefined ? '' : ` LIMIT $${values.length}`}`,
      values,
    );
    return result.rows.map((row) => row.event).reverse();
  }

  public async appendEvidence(evidence: OperationEvidence): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query(
      `INSERT INTO operation_evidence
        (id, tenant_id, project_id, deployment_id, run_id, unit_id, operation, attempt, status, occurred_at,
        input_hash, output_hash, error, metadata, idempotency_key, actor, source, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
       ON CONFLICT (id) DO NOTHING`,
      [
        evidence.id,
        evidence.tenantId ?? null,
        evidence.projectId ?? null,
        evidence.deploymentId ?? null,
        evidence.runId,
        evidence.unitId,
        evidence.operation,
        evidence.attempt,
        evidence.status,
        evidence.occurredAt,
        evidence.inputHash ?? null,
        evidence.outputHash ?? null,
        evidence.error ?? null,
        JSON.stringify(evidence.metadata ?? {}),
        evidence.idempotencyKey ?? null,
        evidence.actor ?? null,
        evidence.source ?? null,
        evidence.correlationId ?? null,
      ],
    );
  }

  /** Persist artifacts separately from mutable control-plane state. The
   * content-addressed ID is the immutable key; a conflicting payload is
   * rejected instead of silently overwritten. */
  public async appendArtifact(artifact: ArtifactRecord): Promise<void> {
    await this.ensureInitialized();
    const existing = await this.pool.query<{ environment: string; compiler_version: string; sources: unknown; workflows: unknown }>(
      'SELECT environment, compiler_version, sources, workflows FROM artifacts WHERE tenant_id = $1 AND project_id = $2 AND id = $3',
      [artifact.tenantId, artifact.projectId, artifact.id],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.environment !== artifact.environment || row.compiler_version !== artifact.compilerVersion || JSON.stringify(row.sources) !== JSON.stringify(artifact.sources) || JSON.stringify(row.workflows) !== JSON.stringify(artifact.workflows)) {
        throw new Error(`Artifact ${artifact.id} already exists with different content.`);
      }
      return;
    }
    await this.pool.query(
      `INSERT INTO artifacts (tenant_id, project_id, id, environment, compiler_version, sources, workflows, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz)`,
      [artifact.tenantId, artifact.projectId, artifact.id, artifact.environment, artifact.compilerVersion, JSON.stringify(artifact.sources), JSON.stringify(artifact.workflows), artifact.createdAt],
    );
  }

  public async listEvidence(query?: string | EvidenceQuery): Promise<OperationEvidence[]> {
    await this.ensureInitialized();
    const filter: EvidenceQuery = typeof query === 'string' ? { runId: query } : query ?? {};
    const clauses: string[] = [];
    const values: string[] = [];
    const add = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    };
    add('run_id', filter.runId);
    add('deployment_id', filter.deploymentId);
    add('tenant_id', filter.tenantId);
    add('project_id', filter.projectId);
    add('unit_id', filter.unitId);
    add('operation', filter.operation);
    add('status', filter.status);
    if (filter.from !== undefined) { values.push(filter.from); clauses.push(`occurred_at >= $${values.length}::timestamptz`); }
    if (filter.to !== undefined) { values.push(filter.to); clauses.push(`occurred_at <= $${values.length}::timestamptz`); }
    const addMetadata = (key: string, value: string | undefined): void => { if (value === undefined) return; values.push(value); clauses.push(`metadata ->> '${key}' = $${values.length}`); };
    addMetadata('repository.name', filter.repository);
    if (filter.revision !== undefined) { values.push(filter.revision); clauses.push(`(metadata ->> 'repository.revision' = $${values.length} OR metadata ->> 'repository.base_revision' = $${values.length})`); }
    addMetadata('repository.revision', filter.commit);
    addMetadata('pull_request.number', filter.pullRequest);
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const result = await this.pool.query<OperationEvidence>(`SELECT id, tenant_id AS "tenantId", project_id AS "projectId", deployment_id AS "deploymentId", run_id AS "runId", unit_id AS "unitId", operation, idempotency_key AS "idempotencyKey", actor, source, correlation_id AS "correlationId", attempt, status, occurred_at AS "occurredAt", input_hash AS "inputHash", output_hash AS "outputHash", error, metadata FROM operation_evidence${where} ORDER BY occurred_at ASC`, values);
    return result.rows;
  }

  public async pruneEvents(before: string): Promise<number> {
    await this.ensureInitialized();
    let deleted = 0;
    while (true) {
      const result = await this.pool.query(
        `WITH expired AS (
           SELECT id FROM observability_events
           WHERE timestamp < $1::timestamptz
           ORDER BY timestamp ASC
           LIMIT 5_000
         )
         DELETE FROM observability_events events
         USING expired
         WHERE events.id = expired.id`,
        [before],
      );
      const batch = result.rowCount ?? 0;
      deleted += batch;
      if (batch < 5_000) break;
    }
    return deleted;
  }

  public async pruneEvidence(before: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.pool.query('DELETE FROM operation_evidence WHERE occurred_at < $1::timestamptz', [before]);
    return result.rowCount ?? 0;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async load(): Promise<PlatformState> {
    await this.ensureInitialized();
    const result = await this.pool.query<StateRow>(
      'SELECT state FROM platform_state WHERE id = 1',
    );
    const state = result.rows[0]?.state;
    if (state === undefined) throw new Error('PostgreSQL platform state is missing.');
    return normalizePlatformState(state);
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize();
    await this.initialized;
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS platform_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS artifacts (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        environment TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        sources JSONB NOT NULL,
        workflows JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, project_id, id)
      )
    `);
    await this.pool.query(
      `INSERT INTO platform_state (id, state)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(createSeedState())],
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS observability_events (
        id UUID PRIMARY KEY,
        tenant_id TEXT,
        project_id TEXT,
        run_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        signal TEXT NOT NULL CHECK (signal IN ('log', 'metric')),
        event_type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        span_kind TEXT,
        severity_text TEXT,
        node_id TEXT,
        event JSONB NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS operation_evidence (
        id UUID PRIMARY KEY,
        tenant_id TEXT,
        project_id TEXT,
        run_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out')),
        occurred_at TIMESTAMPTZ NOT NULL,
        input_hash TEXT,
        output_hash TEXT,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        ,deployment_id TEXT
        ,idempotency_key TEXT,
        actor TEXT,
        source TEXT,
        correlation_id TEXT
      )
    `);
    await this.pool.query(`ALTER TABLE operation_evidence DROP CONSTRAINT IF EXISTS operation_evidence_status_check`);
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS deployment_id TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS actor TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS source TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS correlation_id TEXT');
    await this.pool.query(`ALTER TABLE operation_evidence ADD CONSTRAINT operation_evidence_status_check CHECK (status IN ('started', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out'))`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS operation_evidence_run_time_idx ON operation_evidence (run_id, occurred_at)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS operation_evidence_project_time_idx ON operation_evidence (project_id, occurred_at)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS operation_evidence_deployment_time_idx ON operation_evidence (deployment_id, occurred_at)');
    await this.pool.query('ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS tenant_id TEXT');
    await this.pool.query('ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS project_id TEXT');
    // Attributes are already embedded in event JSON. Keeping a second JSONB
    // copy doubled storage for the highest-volume table.
    await this.pool.query('ALTER TABLE observability_events DROP COLUMN IF EXISTS attributes');
    // The compact telemetry profile has no trace retention path. Remove any
    // trace rows left by a pre-compact deployment during startup migration.
    await this.pool.query("DELETE FROM observability_events WHERE signal = 'trace'");
    await this.pool.query('ALTER TABLE observability_events DROP CONSTRAINT IF EXISTS observability_events_signal_check');
    await this.pool.query("ALTER TABLE observability_events ADD CONSTRAINT observability_events_signal_check CHECK (signal IN ('log', 'metric'))");
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_project_time_idx ON observability_events (project_id, timestamp)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_run_time_idx ON observability_events (run_id, timestamp)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_signal_time_idx ON observability_events (signal, timestamp)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_timestamp_idx ON observability_events (timestamp)',
    );
    await this.migrateLegacyEvents();
  }

  private async migrateLegacyEvents(): Promise<void> {
    const result = await this.pool.query<StateRow>(
      'SELECT state FROM platform_state WHERE id = 1 FOR UPDATE',
    );
    const state = result.rows[0]?.state;
    if (state === undefined || state.events.length === 0) return;
    normalizePlatformState(state);
    for (const event of state.events) {
      if (event.signal === 'trace') continue;
      const migratedEvent: RunEvent = {
        ...event,
        signal: event.signal ?? 'log',
        traceId: event.traceId ?? event.runId.replaceAll('-', '').padEnd(32, '0').slice(0, 32),
        spanId: event.spanId ?? event.id.replaceAll('-', '').slice(0, 16),
      };
      await this.pool.query(
        `INSERT INTO observability_events
          (id, tenant_id, project_id, run_id, timestamp, signal, event_type, trace_id, span_id, node_id, event)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          migratedEvent.tenantId ?? null,
          migratedEvent.projectId ?? null,
          event.runId,
          event.timestamp,
          migratedEvent.signal,
          migratedEvent.type,
          migratedEvent.traceId,
          migratedEvent.spanId,
          migratedEvent.nodeId ?? null,
          JSON.stringify(migratedEvent),
        ],
      );
    }
    state.events = [];
    await this.pool.query(
      'UPDATE platform_state SET state = $1::jsonb, updated_at = now() WHERE id = 1',
      [JSON.stringify(normalizePlatformState(state))],
    );
  }
}
