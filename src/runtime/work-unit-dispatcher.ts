import { createHash } from 'node:crypto';

import type { WorkUnitDefinition, WorkUnitEnvelope, WorkUnitKind, WorkflowNode } from '../domain/types.js';

export interface WorkUnitDispatchContext {
  runId: string;
  traceId: string;
  sequence: number;
  node: WorkflowNode;
  inputs: unknown[];
  signal: AbortSignal;
  execute: () => Promise<unknown> | unknown;
}

export type WorkUnitAdapter = (input: {
  envelope: WorkUnitEnvelope;
  context: WorkUnitDispatchContext;
}) => Promise<unknown> | unknown;

const supportedKinds: WorkUnitKind[] = [
  'deterministic',
  'agent',
  'human',
  'connector',
  'consumer',
  'evaluator',
];

function key(kind: string, version: number): string {
  return `${kind}@${version}`;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload) ?? 'undefined').digest('hex');
}

function validatePayload(schemaName: string, payload: unknown, direction: 'input' | 'output'): void {
  const schema = schemaName.trim().toLowerCase();
  if (schema === '' || schema === 'any' || schema === 'unknown' || schema.startsWith('$ref:')) return;
  const valid = schema === 'string'
    ? typeof payload === 'string'
    : schema === 'number'
      ? typeof payload === 'number' && Number.isFinite(payload)
      : schema === 'boolean'
        ? typeof payload === 'boolean'
        : schema === 'object'
          ? typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          : schema === 'array'
            ? Array.isArray(payload)
            : true;
  if (!valid) throw new Error(`WorkUnit ${direction} does not match declared schema "${schemaName}".`);
}

/**
 * Resolves versioned WorkUnit adapters and enforces the common execution contract.
 * Built-in adapters are intentionally registered as a generic bridge; domain
 * adapters can replace them by registering the same kind and version.
 */
export class WorkUnitDispatcher {
  private readonly adapters = new Map<string, WorkUnitAdapter>();

  public constructor() {
    for (const kind of supportedKinds) {
      this.register(kind, 1, ({ context }) => context.execute());
    }
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
    const inputPayload = context.inputs.length === 1 ? context.inputs[0] : context.inputs;
    validatePayload(unit.inputSchema, inputPayload, 'input');

    const attempts = Math.max(1, unit.retryAttempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      context.signal.throwIfAborted();
      const envelope: WorkUnitEnvelope = {
        runId: context.runId,
        traceId: context.traceId,
        unitId: context.node.id,
        sequence: context.sequence,
        attempt,
        schema: unit.inputSchema,
        payload: inputPayload,
        contentHash: hashPayload(inputPayload),
      };
      try {
        const adapter = this.adapters.get(key(unit.kind, unit.version));
        if (adapter === undefined) throw new Error(`No WorkUnit adapter registered for ${unit.kind}@${unit.version}.`);
        const result = await adapter({ envelope, context });
        validatePayload(unit.outputSchema, result, 'output');
        return result;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('WorkUnit execution failed.');
  }
}
