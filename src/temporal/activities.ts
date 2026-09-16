import { defaultWorkUnit } from '../domain/catalog.js';
import type { WorkUnitDefinition, WorkflowNode } from '../domain/types.js';
import { WorkUnitDispatcher } from '../runtime/work-unit-dispatcher.js';

export interface NodeActivityInput {
  runId: string;
  nodeId: string;
  nodeType: string;
  label: string;
  config: Record<string, unknown>;
  traceId?: string;
  sequence?: number;
  inputs?: unknown[];
  unit?: WorkUnitDefinition;
}

export interface NodeActivityResult {
  nodeId: string;
  result: unknown;
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
  const controller = new AbortController();
  const result = await new WorkUnitDispatcher().dispatch(node.unit, {
    runId: input.runId,
    traceId: input.traceId ?? input.runId,
    sequence: input.sequence ?? 1,
    node,
    inputs: input.inputs ?? [],
    signal: controller.signal,
    execute: (signal = controller.signal) => executeNodeImplementation(input, signal),
  });
  return { nodeId: input.nodeId, result };
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
      const maxIterations = typeof input.config.maxIterations === 'number' ? input.config.maxIterations : 1;
      return { iterations: maxIterations, outcome: 'bounded-completion' };
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
    default:
      return input.config.value ?? true;
  }
}
