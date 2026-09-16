import { Pool, type PoolConfig } from 'pg';

import { createSeedState } from '../domain/seed.js';
import type { EvidenceQuery, OperationEvidence, PlatformState, RunEvent } from '../domain/types.js';
import { normalizePlatformState, type PlatformStore, type StateMutation } from './store.js';

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

  public async appendEvent(event: RunEvent): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query(
      `INSERT INTO observability_events
        (id, tenant_id, project_id, run_id, timestamp, signal, event_type, trace_id, span_id,
         parent_span_id, span_kind, severity_text, node_id, attributes, event)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
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
        JSON.stringify(event.attributes ?? {}),
        JSON.stringify(event),
      ],
    );
  }

  public async listEvents(runId?: string): Promise<RunEvent[]> {
    await this.ensureInitialized();
    const result = runId === undefined
      ? await this.pool.query<{ event: RunEvent }>(
          'SELECT event FROM observability_events ORDER BY timestamp ASC',
        )
      : await this.pool.query<{ event: RunEvent }>(
          'SELECT event FROM observability_events WHERE run_id = $1 ORDER BY timestamp ASC',
          [runId],
        );
    return result.rows.map((row) => row.event);
  }

  public async appendEvidence(evidence: OperationEvidence): Promise<void> {
    await this.ensureInitialized();
    await this.pool.query(
      `INSERT INTO operation_evidence
        (id, tenant_id, project_id, run_id, unit_id, operation, attempt, status, occurred_at,
        input_hash, output_hash, error, metadata, idempotency_key, actor, source, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
       ON CONFLICT (id) DO NOTHING`,
      [
        evidence.id,
        evidence.tenantId ?? null,
        evidence.projectId ?? null,
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
    const result = await this.pool.query<OperationEvidence>(`SELECT id, tenant_id AS "tenantId", project_id AS "projectId", run_id AS "runId", unit_id AS "unitId", operation, idempotency_key AS "idempotencyKey", actor, source, correlation_id AS "correlationId", attempt, status, occurred_at AS "occurredAt", input_hash AS "inputHash", output_hash AS "outputHash", error, metadata FROM operation_evidence${where} ORDER BY occurred_at ASC`, values);
    return result.rows;
  }

  public async pruneEvents(before: string): Promise<number> {
    await this.ensureInitialized();
    const result = await this.pool.query(
      'DELETE FROM observability_events WHERE timestamp < $1::timestamptz',
      [before],
    );
    return result.rowCount ?? 0;
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
        signal TEXT NOT NULL CHECK (signal IN ('log', 'trace', 'metric')),
        event_type TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        span_kind TEXT,
        severity_text TEXT,
        node_id TEXT,
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
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
        ,idempotency_key TEXT,
        actor TEXT,
        source TEXT,
        correlation_id TEXT
      )
    `);
    await this.pool.query(`ALTER TABLE operation_evidence DROP CONSTRAINT IF EXISTS operation_evidence_status_check`);
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS actor TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS source TEXT');
    await this.pool.query('ALTER TABLE operation_evidence ADD COLUMN IF NOT EXISTS correlation_id TEXT');
    await this.pool.query(`ALTER TABLE operation_evidence ADD CONSTRAINT operation_evidence_status_check CHECK (status IN ('started', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out'))`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS operation_evidence_run_time_idx ON operation_evidence (run_id, occurred_at)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS operation_evidence_project_time_idx ON operation_evidence (project_id, occurred_at)');
    await this.pool.query('ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS tenant_id TEXT');
    await this.pool.query('ALTER TABLE observability_events ADD COLUMN IF NOT EXISTS project_id TEXT');
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_project_time_idx ON observability_events (project_id, timestamp)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_run_time_idx ON observability_events (run_id, timestamp)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS observability_events_signal_time_idx ON observability_events (signal, timestamp)',
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
      const migratedEvent: RunEvent = {
        ...event,
        signal: event.signal ?? 'log',
        traceId: event.traceId ?? event.runId.replaceAll('-', '').padEnd(32, '0').slice(0, 32),
        spanId: event.spanId ?? event.id.replaceAll('-', '').slice(0, 16),
      };
      await this.pool.query(
        `INSERT INTO observability_events
          (id, tenant_id, project_id, run_id, timestamp, signal, event_type, trace_id, span_id, node_id, attributes, event)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
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
          JSON.stringify(migratedEvent.attributes ?? {}),
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
