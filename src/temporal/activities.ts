import { createHash } from 'node:crypto';

import { activityInfo, cancellationSignal } from '@temporalio/activity';

import { defaultWorkUnit } from '../domain/catalog.js';
import type { WorkUnitDefinition, WorkflowNode } from '../domain/types.js';
import { RepositoryCheckError, RepositoryCheckTimeoutError, RepositoryWorkspace } from '../repository/workspace.js';
import { WorkUnitDispatcher } from '../runtime/work-unit-dispatcher.js';
import type { TemporalActivityLifecycle, TemporalObservabilitySink } from './observability.js';

let observabilitySink: TemporalObservabilitySink | undefined;
let repositoryWorkspace: RepositoryWorkspace | undefined;

/** Configure the worker-side durable sink; tests can inject a deterministic fake. */
export function configureTemporalObservabilitySink(sink: TemporalObservabilitySink | undefined): void {
  observabilitySink = sink;
}

/** Configure the bounded repository workspace available to repository activities. */
export function configureTemporalRepositoryWorkspace(workspace: RepositoryWorkspace | undefined): void {
  repositoryWorkspace = workspace;
}

export interface NodeActivityInput {
  runId: string;
  workflowId?: string;
  workflowVersion?: number;
  releaseBundleHash?: string;
  pinnedAgentVersions?: Record<string, number>;
  tenantId?: string;
  projectId?: string;
  nodeId: string;
  nodeType: string;
  label: string;
  config: Record<string, unknown>;
  traceId?: string;
  parentSpanId?: string;
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

/** A non-retryable workflow-contract error for kinds not implemented by the worker. */
export class TemporalActivityUnsupportedError extends Error {
  public readonly code = 'TEMPORAL_ACTIVITY_UNSUPPORTED';
  public readonly nodeType: string;

  public constructor(nodeType: string) {
    super(`Temporal activity adapter does not support node type "${nodeType}".`);
    this.name = 'TemporalActivityUnsupportedError';
    this.nodeType = nodeType;
  }
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
    ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
    ...(input.workflowVersion === undefined ? {} : { workflowVersion: input.workflowVersion }),
    ...(input.releaseBundleHash === undefined ? {} : { releaseBundleHash: input.releaseBundleHash }),
    ...(input.pinnedAgentVersions === undefined ? {} : { pinnedAgentVersions: input.pinnedAgentVersions }),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    unitKind: unit.kind,
    unitVersion: unit.version,
    traceId,
    spanId,
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    sequence,
    attempt,
    idempotencyKey,
    inputHash,
  } satisfies Omit<TemporalActivityLifecycle, 'status' | 'occurredAt'>;
  await recordLifecycle({ ...baseLifecycle, status: 'started', occurredAt: new Date(startedAt).toISOString() });
  const controller = new AbortController();
  const unlinkCancellation = linkTemporalCancellation(controller, currentActivityCancellationSignal());
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
  } finally {
    unlinkCancellation();
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

function currentActivityCancellationSignal(): AbortSignal | undefined {
  try {
    return cancellationSignal();
  } catch {
    return undefined;
  }
}

/** Link a Temporal cancellation signal to the controller used by WorkUnits. */
export function linkTemporalCancellation(controller: AbortController, source: AbortSignal | undefined): () => void {
  if (source === undefined) return () => undefined;
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
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
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('HTTP nodes support only http and https URLs.');
      }
      const response = await fetch(parsed, {
        method: typeof input.config.method === 'string' ? input.config.method : 'GET',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`HTTP request failed with status ${response.status}.`);
      return { status: response.status };
    }
    case 'condition':
      return input.config.result === true;
    case 'evaluator':
      return executeDeterministicEvaluator(input.config, input.inputs ?? []);
    case 'repositoryCheck': {
      if (repositoryWorkspace === undefined) {
        throw new Error('Repository workspace is not configured for this Temporal worker.');
      }
      const command = typeof input.config.command === 'string' ? input.config.command : 'npm test';
      const timeoutMs = typeof input.config.timeoutMs === 'number' ? input.config.timeoutMs : undefined;
      const required = input.config.required !== false;
      const check = await repositoryWorkspace.runCheck(command, timeoutMs, signal);
      const result = { ...check, required, promotionBlocked: required && (check.timedOut || check.exitCode !== 0) };
      if (required && check.timedOut) throw new RepositoryCheckTimeoutError(`Required repository check timed out: ${command}.`, check);
      if (required && check.exitCode !== 0) throw new RepositoryCheckError(`Required repository check failed: ${command}.`, check);
      return result;
    }
    case 'repositoryPatch': {
      if (repositoryWorkspace === undefined) {
        throw new Error('Repository workspace is not configured for this Temporal worker.');
      }
      return repositoryWorkspace.patchArtifact();
    }
    case 'approval':
      // The workflow layer holds this activity at a deterministic condition
      // until the operator signal arrives; once dispatched, the human gate is
      // complete and carries no additional payload.
      return true;
    case 'agentLoop': {
      throw new TemporalActivityUnsupportedError(input.nodeType);
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
      throw new TemporalActivityUnsupportedError(input.nodeType);
  }
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function executeDeterministicEvaluator(config: Record<string, unknown>, inputs: unknown[]): Record<string, unknown> {
  const mode = typeof config.mode === 'string' ? config.mode : 'equals';
  const actual = inputs.at(-1) ?? config.actual;
  const expected = config.expected;
  let matched = false;
  switch (mode) {
    case 'equals':
      matched = stableValue(actual) === stableValue(expected);
      break;
    case 'contains':
      matched = typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
      break;
    case 'fieldEquals': {
      const field = typeof config.field === 'string' ? config.field : '';
      const value = actual !== null && typeof actual === 'object' ? (actual as Record<string, unknown>)[field] : undefined;
      matched = stableValue(value) === stableValue(expected);
      break;
    }
    case 'numericGte':
      matched = typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      break;
    case 'exists':
      matched = actual !== undefined && actual !== null;
      break;
    default:
      throw new Error(`Unsupported evaluator mode "${mode}".`);
  }
  const score = matched ? 1 : 0;
  const threshold = typeof config.threshold === 'number' && Number.isFinite(config.threshold)
    ? Math.min(Math.max(config.threshold, 0), 1)
    : 1;
  const result = { score, threshold, passed: score >= threshold, mode };
  if (config.failOnThreshold === true && result.passed === false) {
    throw new Error(`Evaluator threshold failed for mode "${mode}" (score ${score}, threshold ${threshold}).`);
  }
  return result;
}
