import { createHash } from 'node:crypto';

import type { WorkUnitDefinition, WorkUnitEnvelope, WorkUnitKind, WorkflowNode } from '../domain/types.js';

export interface WorkUnitDispatchContext {
  runId: string;
  traceId: string;
  sequence: number;
  node: WorkflowNode;
  inputs: unknown[];
  signal: AbortSignal;
  execute: (signal?: AbortSignal) => Promise<unknown> | unknown;
}

export type WorkUnitAdapter = (input: {
  envelope: WorkUnitEnvelope;
  context: WorkUnitDispatchContext;
}) => Promise<unknown> | unknown;

export type WorkUnitSchemaValidator = (payload: unknown) => boolean;

export class WorkUnitTimeoutError extends Error {
  public readonly code = 'WORK_UNIT_TIMED_OUT';

  public constructor(unitId: string, timeoutMs: number) {
    super(`WorkUnit "${unitId}" timed out after ${timeoutMs}ms.`);
    this.name = 'WorkUnitTimeoutError';
  }
}

const supportedKinds: WorkUnitKind[] = [
  'deterministic',
  'agent',
  'human',
  'connector',
  'consumer',
  'evaluator',
];
const sideEffectingKinds = new Set<WorkUnitKind>(['connector', 'consumer']);

function key(kind: string, version: number): string {
  return `${kind}@${version}`;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload) ?? 'undefined').digest('hex');
}

function validatePayload(
  schemaName: string,
  payload: unknown,
  direction: 'input' | 'output',
  schemas: ReadonlyMap<string, WorkUnitSchemaValidator>,
): void {
  const schema = schemaName.trim().toLowerCase();
  if (schema === '' || schema === 'any' || schema === 'unknown') return;
  const namedSchema = schema.startsWith('$ref:') ? schema.slice('$ref:'.length).trim() : undefined;
  if (namedSchema !== undefined) {
    const validator = schemas.get(namedSchema.toLowerCase());
    if (validator === undefined) throw new Error(`WorkUnit ${direction} references unknown schema "${namedSchema}".`);
    if (!validator(payload)) throw new Error(`WorkUnit ${direction} does not match declared schema "${schemaName}".`);
    return;
  }
  const validator = schemas.get(schema);
  const valid = validator === undefined ? schema === 'string'
    ? typeof payload === 'string'
    : schema === 'number'
      ? typeof payload === 'number' && Number.isFinite(payload)
      : schema === 'boolean'
        ? typeof payload === 'boolean'
        : schema === 'object'
          ? typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          : schema === 'array'
            ? Array.isArray(payload)
            : true : validator(payload);
  if (!valid) throw new Error(`WorkUnit ${direction} does not match declared schema "${schemaName}".`);
}

/**
 * Resolves versioned WorkUnit adapters and enforces the common execution contract.
 * Built-in adapters are intentionally registered as a generic bridge; domain
 * adapters can replace them by registering the same kind and version.
 */
export class WorkUnitDispatcher {
  private readonly adapters = new Map<string, WorkUnitAdapter>();
  private readonly schemas = new Map<string, WorkUnitSchemaValidator>();

  public constructor(schemas: Record<string, WorkUnitSchemaValidator> = {}) {
    this.registerSchema('string', (payload) => typeof payload === 'string');
    this.registerSchema('number', (payload) => typeof payload === 'number' && Number.isFinite(payload));
    this.registerSchema('boolean', (payload) => typeof payload === 'boolean');
    this.registerSchema('object', (payload) => typeof payload === 'object' && payload !== null && !Array.isArray(payload));
    this.registerSchema('array', (payload) => Array.isArray(payload));
    for (const [name, validator] of Object.entries(schemas)) this.registerSchema(name, validator);
    for (const kind of supportedKinds) {
      this.register(kind, 1, ({ context }) => context.execute());
    }
  }

  public registerSchema(name: string, validator: WorkUnitSchemaValidator): void {
    const normalized = name.trim().toLowerCase();
    if (normalized === '' || normalized.includes(' ')) throw new Error('WorkUnit schema names must be non-empty and contain no spaces.');
    this.schemas.set(normalized, validator);
  }

  public register(kind: WorkUnitKind, version: number, adapter: WorkUnitAdapter): void {
    if (!Number.isInteger(version) || version < 1) throw new Error('WorkUnit adapter version must be a positive integer.');
    this.adapters.set(key(kind, version), adapter);
  }

  public async dispatch(
    unit: WorkUnitDefinition | undefined,
    context: WorkUnitDispatchContext,
  ): Promise<unknown> {
    if (unit === undefined) throw new Error(`WorkUnit "${context.node.id}" is missing its execution envelope.`);
    if (!this.adapters.has(key(unit.kind, unit.version))) {
      throw new Error(`No WorkUnit adapter registered for ${unit.kind}@${unit.version}.`);
    }
    if (sideEffectingKinds.has(unit.kind) && (unit.idempotencyKey === undefined || unit.idempotencyKey.trim() === '')) {
      throw new Error(`Side-effecting WorkUnit "${context.node.id}" must declare an idempotency key.`);
    }
    const inputPayload = context.inputs.length === 1 ? context.inputs[0] : context.inputs;
    validatePayload(unit.inputSchema, inputPayload, 'input', this.schemas);

    // A connector/consumer may have committed an external side effect before
    // reporting an error. Never replay that boundary automatically; operators
    // can use the idempotency key and recovery flow to resolve uncertainty.
    const attempts = sideEffectingKinds.has(unit.kind) ? 1 : Math.max(1, unit.retryAttempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      context.signal.throwIfAborted();
      const timeoutController = new AbortController();
      const dispatchSignal = AbortSignal.any([context.signal, timeoutController.signal]);
      const timeoutError = new WorkUnitTimeoutError(context.node.id, unit.timeoutMs);
      let timedOut = false;
      let rejectDeadline: (reason: unknown) => void = () => undefined;
      const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
      const abortDeadline = (): void => rejectDeadline(context.signal.reason);
      context.signal.addEventListener('abort', abortDeadline, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(timeoutError);
        rejectDeadline(timeoutError);
      }, Math.max(1, unit.timeoutMs));
      const envelope: WorkUnitEnvelope = {
        runId: context.runId,
        traceId: context.traceId,
        unitId: context.node.id,
          sequence: context.sequence,
          attempt,
          ...(unit.idempotencyKey === undefined ? {} : { idempotencyKey: unit.idempotencyKey }),
          schema: unit.inputSchema,
        payload: inputPayload,
        contentHash: hashPayload(inputPayload),
      };
      try {
        const adapter = this.adapters.get(key(unit.kind, unit.version));
        if (adapter === undefined) throw new Error(`No WorkUnit adapter registered for ${unit.kind}@${unit.version}.`);
        const adapterContext: WorkUnitDispatchContext = {
          ...context,
          signal: dispatchSignal,
          execute: (signal = dispatchSignal) => context.execute(signal),
        };
        const result = await Promise.race([Promise.resolve(adapter({ envelope, context: adapterContext })), deadline]);
        if (timedOut) throw timeoutError;
        validatePayload(unit.outputSchema, result, 'output', this.schemas);
        return result;
      } catch (error) {
        lastError = timedOut ? timeoutError : error;
        if (timedOut || context.signal.aborted || attempt >= attempts) throw lastError;
      } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', abortDeadline);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('WorkUnit execution failed.');
  }
}
