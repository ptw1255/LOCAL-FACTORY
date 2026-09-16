import { createHash } from 'node:crypto';

import { activityInfo } from '@temporalio/activity';

import { defaultWorkUnit } from '../domain/catalog.js';
import type { WorkUnitDefinition, WorkflowNode } from '../domain/types.js';
import { WorkUnitDispatcher } from '../runtime/work-unit-dispatcher.js';
import type { TemporalActivityLifecycle, TemporalObservabilitySink } from './observability.js';

let observabilitySink: TemporalObservabilitySink | undefined;

/** Configure the worker-side durable sink; tests can inject a deterministic fake. */
export function configureTemporalObservabilitySink(sink: TemporalObservabilitySink | undefined): void {
  observabilitySink = sink;
}

export interface NodeActivityInput {
  runId: string;
  tenantId?: string;
  projectId?: string;
  nodeId: string;
  nodeType: string;
  label: string;
  config: Record<string, unknown>;
  traceId?: string;
  sequence?: number;
  /** Optional deterministic override for direct callers/tests; Temporal workers use activityInfo().attempt. */
  attempt?: number;
  inputs?: unknown[];
  unit?: WorkUnitDefinition;
}

export interface NodeActivityResult {
  nodeId: string;
  result: unknown;
  lifecycle: TemporalActivityLifecycle;
}

/** Executes a Temporal activity through the same envelope contract as local runs. */
export async function executeNodeActivity(
  input: NodeActivityInput,
): Promise<NodeActivityResult> {
  const node: WorkflowNode = {
    id: input.nodeId,
    type: input.nodeType,
    label: input.label,
    position: { x: 0, y: 0 },
    config: input.config,
    unit: input.unit ?? defaultWorkUnit(input.nodeType),
  };
  const unit = node.unit ?? defaultWorkUnit(input.nodeType);
  const traceId = input.traceId ?? input.runId;
  const sequence = input.sequence ?? 1;
  const spanId = createHash('sha256').update(`${input.runId}:${input.nodeId}:${sequence}`).digest('hex').slice(0, 16);
  const idempotencyKey = `${input.runId}:temporal:${input.nodeId}:${sequence}`;
  const attempt = input.attempt ?? currentActivityAttempt();
  const startedAt = Date.now();
  const inputHash = hashPayload(input.inputs ?? []);
  const baseLifecycle = {
    runId: input.runId,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    unitKind: unit.kind,
    unitVersion: unit.version,
    traceId,
    spanId,
    sequence,
    attempt,
    idempotencyKey,
    inputHash,
  } satisfies Omit<TemporalActivityLifecycle, 'status' | 'occurredAt'>;
  await recordLifecycle({ ...baseLifecycle, status: 'started', occurredAt: new Date(startedAt).toISOString() });
  const controller = new AbortController();
  try {
    const result = await new WorkUnitDispatcher().dispatch(unit, {
      runId: input.runId,
      traceId,
      sequence,
      node,
      inputs: input.inputs ?? [],
      signal: controller.signal,
      execute: (signal = controller.signal) => executeNodeImplementation(input, signal),
    });
    const lifecycle: TemporalActivityLifecycle = {
      ...baseLifecycle,
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      outputHash: hashPayload(result),
    };
    await recordLifecycle(lifecycle);
    return { nodeId: input.nodeId, result, lifecycle };
  } catch (error) {
    const lifecycle: TemporalActivityLifecycle = {
      ...baseLifecycle,
      status: 'failed',
      occurredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ...(error instanceof Error ? { error: error.message.slice(0, 2_000) } : { error: 'Temporal activity failed.' }),
    };
    await recordLifecycle(lifecycle);
    throw error;
  }
}

/**
 * Temporal's activity context is unavailable when the activity is invoked
 * directly in unit tests or local tooling. Keep that path deterministic while
 * preserving the real retry number inside a worker.
 */
function currentActivityAttempt(): number {
  try {
    const attempt = activityInfo().attempt;
    return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
  } catch {
    return 1;
  }
}

async function recordLifecycle(lifecycle: TemporalActivityLifecycle): Promise<void> {
  try {
    await observabilitySink?.record(lifecycle);
  } catch {
    // Observability failures must not change the WorkUnit result or retry path.
  }
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload) ?? 'undefined').digest('hex');
}

async function executeNodeImplementation(
  input: NodeActivityInput,
  signal: AbortSignal,
): Promise<unknown> {
  switch (input.nodeType) {
    case 'wait': {
      const durationMs = typeof input.config.durationMs === 'number'
        ? Math.min(Math.max(input.config.durationMs, 0), 60_000)
        : 250;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, durationMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return durationMs;
    }
    case 'httpRequest': {
      const url = input.config.url;
      if (typeof url !== 'string' || url.trim() === '') return { simulated: true, status: 200 };
      const response = await fetch(url, {
        method: typeof input.config.method === 'string' ? input.config.method : 'GET',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`HTTP request failed with status ${response.status}.`);
      return { status: response.status };
    }
    case 'condition':
      return input.config.result === true;
    case 'agentLoop': {
      throw new Error('Temporal agentLoop activity adapter is not available; use the local execution plane until provider parity is configured.');
    }
    case 'code': {
      const operation = typeof input.config.operation === 'string' ? input.config.operation : 'identity';
      const value = input.config.value ?? '';
      switch (operation) {
        case 'identity': return value;
        case 'uppercase': return String(value).toUpperCase();
        case 'lowercase': return String(value).toLowerCase();
        case 'trim': return String(value).trim();
        case 'json.parse': return JSON.parse(String(value)) as unknown;
        case 'json.stringify': return JSON.stringify(value);
        default: throw new Error(`Unsupported deterministic code operation "${operation}".`);
      }
    }
    case 'manualTrigger':
    case 'scheduleTrigger':
    case 'webhookTrigger':
      return input.inputs?.length === 1 ? input.inputs[0] : input.inputs !== undefined && input.inputs.length > 1 ? input.inputs : true;
    case 'transform':
    case 'output':
      return input.config.value ?? true;
    case 'notification':
      return { emitted: true, channel: input.config.channel ?? 'default' };
    default:
      throw new Error(`Temporal activity adapter does not support node type "${input.nodeType}".`);
  }
}
