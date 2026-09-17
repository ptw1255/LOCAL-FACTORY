import { createHash } from 'node:crypto';

import { activityInfo, cancellationSignal } from '@temporalio/activity';

import { defaultWorkUnit } from '../domain/catalog.js';
import type { AgentDefinition, WorkUnitDefinition, WorkflowNode } from '../domain/types.js';
import { parseRepositoryCheckSandbox, RepositoryCheckError, RepositoryCheckTimeoutError, RepositoryWorkspace } from '../repository/workspace.js';
import { RepositoryCiError, RepositoryMergeError, RepositoryReviewError, type GitHubRepositoryClient } from '../repository/github.js';
import { WorkUnitDispatcher } from '../runtime/work-unit-dispatcher.js';
import type { OllamaClient } from '../runtime/ollama.js';
import type { OpenAIClient, OpenAIModelResult } from '../runtime/openai.js';
import type { TemporalActivityLifecycle, TemporalObservabilitySink } from './observability.js';

let observabilitySink: TemporalObservabilitySink | undefined;
let repositoryWorkspace: RepositoryWorkspace | undefined;
let repositoryRunRoot: string | undefined;
const runWorkspaces = new Map<string, RepositoryWorkspace>();
type TemporalGitHubRepository = Pick<GitHubRepositoryClient, 'createOrGetPullRequest' | 'waitForPullRequestStatus' | 'mergePullRequest' | 'waitForChecks'>;
let githubRepository: TemporalGitHubRepository | undefined;
export type TemporalModelClient = Pick<OpenAIClient, 'chat' | 'provider' | 'capabilities'>;
let modelClients: ReadonlyMap<string, TemporalModelClient> = new Map();
let ollamaClient: OllamaClient | undefined;

/** Configure the worker-side durable sink; tests can inject a deterministic fake. */
export function configureTemporalObservabilitySink(sink: TemporalObservabilitySink | undefined): void {
  observabilitySink = sink;
}

/** Configure the bounded repository workspace available to repository activities. */
export function configureTemporalRepositoryWorkspace(workspace: RepositoryWorkspace | undefined, options: { runRoot?: string } = {}): void {
  repositoryWorkspace = workspace;
  repositoryRunRoot = options.runRoot?.trim() || undefined;
  if (workspace === undefined) runWorkspaces.clear();
}

/** Configure the worker-side GitHub adapter; tests can inject a deterministic fake. */
export function configureTemporalGitHubRepository(repository: TemporalGitHubRepository | undefined): void {
  githubRepository = repository;
}

/** Configure provider adapters used by Temporal agent-loop activities. */
export function configureTemporalModelProviders(options: { clients?: ReadonlyMap<string, TemporalModelClient>; ollama?: OllamaClient } = {}): void {
  modelClients = options.clients ?? new Map();
  ollamaClient = options.ollama;
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
  const activityAgent = input.nodeType === 'agentLoop' ? parseAgentDefinition(input.config.agent) : undefined;
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
    ...(activityAgent === undefined ? {} : { agentId: activityAgent.id, agentVersion: activityAgent.version }),
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

async function workspaceForRun(runId: string): Promise<RepositoryWorkspace> {
  if (repositoryWorkspace === undefined) throw new Error('Repository workspace is not configured for this Temporal worker.');
  const existing = runWorkspaces.get(runId);
  if (existing !== undefined) return existing;
  const isolated = await repositoryWorkspace.cloneForRun(runId, repositoryRunRoot === undefined ? {} : { rootDirectory: repositoryRunRoot });
  runWorkspaces.set(runId, isolated);
  return isolated;
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
      const check = await (await workspaceForRun(input.runId)).runCheck(command, timeoutMs, signal, { sandbox: parseRepositoryCheckSandbox(input.config.sandbox) });
      const result = { ...check, required, promotionBlocked: required && (check.timedOut || check.exitCode !== 0) };
      if (required && check.timedOut) throw new RepositoryCheckTimeoutError(`Required repository check timed out: ${command}.`, check);
      if (required && check.exitCode !== 0) throw new RepositoryCheckError(`Required repository check failed: ${command}.`, check);
      return result;
    }
    case 'repositoryPatch': {
      if (repositoryWorkspace === undefined) {
        throw new Error('Repository workspace is not configured for this Temporal worker.');
      }
      return (await workspaceForRun(input.runId)).patchArtifact();
    }
    case 'repositoryMutation': {
      const capabilities = Array.isArray(input.config.capabilities) ? input.config.capabilities.filter((value): value is string => typeof value === 'string') : [];
      if (!capabilities.includes('repository.write')) throw new Error('Repository mutation requires the declared "repository.write" capability.');
      const operations = Array.isArray(input.config.operations) ? input.config.operations : [];
      const protectedPaths = Array.isArray(input.config.protectedPaths) ? input.config.protectedPaths.filter((value): value is string => typeof value === 'string') : [];
      return (await workspaceForRun(input.runId)).applyMutationsTransaction(operations, { protectedPaths });
    }
    case 'repositoryBranch': {
      const branch = typeof input.config.branch === 'string' ? input.config.branch : '';
      const baseRevision = typeof input.config.baseRevision === 'string' && input.config.baseRevision !== '' ? input.config.baseRevision : await (await workspaceForRun(input.runId)).revision();
      return (await workspaceForRun(input.runId)).createBranch(branch, baseRevision);
    }
    case 'repositoryCommit': {
      const workspace = await workspaceForRun(input.runId);
      const message = typeof input.config.message === 'string' ? input.config.message : '';
      const paths = Array.isArray(input.config.paths) ? input.config.paths.filter((value): value is string => typeof value === 'string') : [];
      if (input.config.requirePatchArtifact === true) await assertPatchBinding(workspace, input.inputs ?? [], paths);
      return workspace.commit(message, paths);
    }
    case 'repositoryPush': {
      const workspace = await workspaceForRun(input.runId);
      const branch = typeof input.config.branch === 'string' && input.config.branch !== '' ? input.config.branch : await workspace.currentBranch();
      const remote = typeof input.config.remote === 'string' ? input.config.remote : 'origin';
      const allowedRemotes = Array.isArray(input.config.allowedRemotes) ? input.config.allowedRemotes.filter((value): value is string => typeof value === 'string') : ['origin'];
      return workspace.push(branch, remote, { allowedRemotes });
    }
    case 'repositoryPullRequest': {
      if (githubRepository === undefined) throw new Error('GitHub repository integration is not configured for this Temporal worker.');
      const title = typeof input.config.title === 'string' ? input.config.title : '';
      const body = typeof input.config.body === 'string' ? input.config.body : '';
      const head = typeof input.config.head === 'string' && input.config.head !== '' ? input.config.head : await (await workspaceForRun(input.runId)).currentBranch();
      const base = typeof input.config.base === 'string' && input.config.base !== '' ? input.config.base : 'main';
      return githubRepository.createOrGetPullRequest({ title, body, head, base });
    }
    case 'repositoryReview': {
      if (githubRepository === undefined) throw new Error('GitHub repository integration is not configured for this Temporal worker.');
      const configuredNumber = typeof input.config.number === 'number' && input.config.number > 0 ? input.config.number : undefined;
      const inputNumber = configuredNumber === undefined
        ? (input.inputs ?? []).map((value) => value !== null && typeof value === 'object' && typeof (value as { number?: unknown }).number === 'number' ? (value as { number: number }).number : undefined).find((value): value is number => value !== undefined)
        : undefined;
      const number = configuredNumber ?? inputNumber;
      if (number === undefined) throw new Error('Repository review requires a pull request number or upstream pull request result.');
      const requiredApprovals = typeof input.config.requiredApprovals === 'number' ? input.config.requiredApprovals : undefined;
      const timeoutMs = typeof input.config.timeoutMs === 'number' ? Math.max(1, input.config.timeoutMs) : 120_000;
      const intervalMs = typeof input.config.intervalMs === 'number' ? Math.max(10, input.config.intervalMs) : 2_000;
      const review = await githubRepository.waitForPullRequestStatus({ number, requiredApprovals, timeoutMs, intervalMs, signal });
      if (input.config.failurePolicy !== 'route' && !['approved', 'merged'].includes(review.status)) {
        throw new RepositoryReviewError(`Pull request #${number} did not reach an approved state: ${review.status}.`, review);
      }
      return review;
    }
    case 'repositoryMerge': {
      if (githubRepository === undefined) throw new Error('GitHub repository integration is not configured for this Temporal worker.');
      const configuredNumber = typeof input.config.number === 'number' && input.config.number > 0 ? input.config.number : undefined;
      const inputNumber = configuredNumber === undefined
        ? (input.inputs ?? []).map((value) => value !== null && typeof value === 'object' && typeof (value as { number?: unknown }).number === 'number' ? (value as { number: number }).number : undefined).find((value): value is number => value !== undefined)
        : undefined;
      const number = configuredNumber ?? inputNumber;
      if (number === undefined) throw new Error('Repository merge requires a pull request number or upstream pull request result.');
      const configuredMethod = input.config.method;
      const method = configuredMethod === 'merge' || configuredMethod === 'rebase' || configuredMethod === 'squash' ? configuredMethod : 'squash';
      const merge = await githubRepository.mergePullRequest({ number, method, ...(typeof input.config.commitTitle === 'string' ? { commitTitle: input.config.commitTitle } : {}), ...(typeof input.config.commitMessage === 'string' ? { commitMessage: input.config.commitMessage } : {}) });
      if (!merge.merged) throw new RepositoryMergeError(`Pull request #${number} was not merged: ${merge.message}.`, merge);
      return merge;
    }
    case 'repositoryCi': {
      if (githubRepository === undefined) throw new Error('GitHub repository integration is not configured for this Temporal worker.');
      const ref = typeof input.config.ref === 'string' && input.config.ref !== '' ? input.config.ref : await (await workspaceForRun(input.runId)).revision();
      const required = Array.isArray(input.config.required) ? input.config.required.filter((value): value is string => typeof value === 'string') : [];
      const timeoutMs = typeof input.config.timeoutMs === 'number' ? Math.max(1, input.config.timeoutMs) : 120_000;
      const intervalMs = typeof input.config.intervalMs === 'number' ? Math.max(10, input.config.intervalMs) : 2_000;
      const ci = await githubRepository.waitForChecks({ ref, required, timeoutMs, intervalMs, signal });
      if (input.config.failurePolicy !== 'route' && ci.status !== 'success') {
        throw new RepositoryCiError(`Repository CI did not pass for ${ref}: ${ci.status}.`, ci);
      }
      return ci;
    }
    case 'approval':
      // The workflow layer holds this activity at a deterministic condition
      // until the operator signal arrives; once dispatched, the human gate is
      // complete and carries no additional payload.
      return true;
    case 'agentLoop':
      return executeTemporalAgentLoop(input, signal);
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

async function assertPatchBinding(workspace: RepositoryWorkspace, inputs: unknown[], paths: string[]): Promise<void> {
  const patches = inputs.map((value) => {
    if (value !== null && typeof value === 'object' && 'patch' in value && (value as { patch?: unknown }).patch !== null && typeof (value as { patch?: unknown }).patch === 'object') return (value as { patch?: unknown }).patch;
    return value;
  }).filter((value): value is { id: string; changedPaths?: unknown[]; files?: unknown[] } => value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && Array.isArray((value as { changedPaths?: unknown[] }).changedPaths));
  if (patches.length === 0) throw new Error('Repository commit requires an upstream patch artifact.');
  if (patches.length > 1) throw new Error('Repository commit requires exactly one unambiguous upstream patch artifact.');
  const patch = patches[0]!;
  const changedPaths = patch.changedPaths?.filter((value): value is string => typeof value === 'string') ?? [];
  const selectedPaths = paths.length === 0 ? changedPaths : paths;
  if (selectedPaths.some((value) => !changedPaths.includes(value))) throw new Error('Repository commit paths must be contained in the approved patch artifact.');
  if (patch.files !== undefined && patch.files.length > 0) {
    for (const selectedPath of selectedPaths) {
      const expected = patch.files.find((value) => value !== null && typeof value === 'object' && (value as { path?: unknown }).path === selectedPath) as { path: string; sha256?: unknown } | undefined;
      if (expected === undefined) throw new Error(`Repository commit path "${selectedPath}" is missing from the approved patch file manifest.`);
      let actualSha: string | undefined;
      try { actualSha = createHash('sha256').update(await workspace.read(selectedPath)).digest('hex'); } catch { actualSha = undefined; }
      if (actualSha !== (typeof expected.sha256 === 'string' ? expected.sha256 : undefined)) throw new Error(`Repository commit content for "${selectedPath}" no longer matches the approved patch artifact.`);
    }
  }
}

async function executeTemporalAgentLoop(input: NodeActivityInput, signal: AbortSignal): Promise<Record<string, unknown>> {
  const agent = parseAgentDefinition(input.config.agent);
  if (agent === undefined) throw new Error('Agent loop references a missing agent definition.');
  const maxIterations = typeof input.config.maxIterations === 'number'
    ? Math.min(Math.max(1, Math.floor(input.config.maxIterations)), agent.limits.maxIterations)
    : agent.limits.maxIterations;
  const goal = typeof input.config.goal === 'string' ? input.config.goal : 'Complete the task.';
  const outputs: Array<{ provider: string; result: OpenAIModelResult; routeIndex: number }> = [];
  let totalCostUsd = 0;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    signal.throwIfAborted();
    const invocations = await invokeTemporalRoutes(agent, goal, signal, input.traceId ?? input.runId);
    for (const invocation of invocations) {
      const toolCalls = invocation.result.toolCalls ?? [];
      if (toolCalls.length > 0) {
        const undeclared = toolCalls.find((call) => !agent.tools.includes(call.name));
        if (undeclared !== undefined) throw new Error(`Agent "${agent.id}" requested undeclared tool "${undeclared.name}".`);
        throw new Error('Temporal agent tool execution requires a configured durable tool adapter.');
      }
      outputs.push(invocation);
      totalCostUsd += invocation.result.estimatedCostUsd ?? (invocation.provider === 'ollama' ? 0 : 0.0015);
    }
    if (totalCostUsd > agent.limits.maxCostUsd) throw new Error(`Agent "${agent.id}" exceeded its maxCostUsd limit.`);
  }
  const last = outputs.at(-1);
  if (last === undefined) throw new Error(`Agent "${agent.id}" did not produce a model result.`);
  const strategy = agent.model.routing?.strategy ?? ((agent.model.routes?.length ?? 0) > 1 ? 'fallback' : 'single');
  return {
    iterations: maxIterations,
    outcome: 'bounded-completion',
    output: last.result.content,
    agentId: agent.id,
    agentVersion: agent.version,
    provider: last.provider,
    model: last.result.model,
    routeIndex: last.routeIndex,
    routingStrategy: strategy,
    costUsd: Number(totalCostUsd.toFixed(6)),
  };
}

async function invokeTemporalRoutes(agent: AgentDefinition, goal: string, signal: AbortSignal, traceId: string): Promise<Array<{ provider: string; result: OpenAIModelResult; routeIndex: number }>> {
  const declaredRoutes = agent.model.routes ?? [];
  const routes: Array<{ provider?: string; model?: string; endpoint?: string; secretRef?: string; capabilities?: AgentDefinition['model']['capabilities']; adapterVersion?: string }> = declaredRoutes.length === 0 ? [agent.model] : declaredRoutes;
  const strategy = agent.model.routing?.strategy ?? (declaredRoutes.length > 1 ? 'fallback' : 'single');
  const maxAttempts = Math.min(routes.length, Math.max(1, Math.floor(agent.model.routing?.maxAttempts ?? routes.length)));
  const results: Array<{ provider: string; result: OpenAIModelResult; routeIndex: number }> = [];
  let lastError: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    const route = routes[index]!;
    const routeAgent: AgentDefinition = declaredRoutes.length === 0
      ? agent
      : { ...agent, model: { ...agent.model, ...route, routes: undefined, routing: undefined } };
    const provider = routeAgent.model.provider?.trim().toLowerCase();
    if (provider === undefined || provider === '') {
      lastError = new Error(`Agent "${agent.id}" provider route ${index + 1} is missing a provider.`);
      if (strategy === 'fallback') continue;
      throw lastError;
    }
    const allowedConnections = agent.boundaries.allowedConnections.map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (allowedConnections.length > 0 && !allowedConnections.includes(provider)) {
      throw new Error(`Agent "${agent.id}" is not authorized to use the "${provider}" connection.`);
    }
    const client = provider === 'ollama'
      ? ollamaClient === undefined ? undefined : ollamaAdapter(ollamaClient)
      : modelClients.get(provider) ?? modelClients.get(provider === 'lm-studio' ? 'lmstudio' : provider);
    if (client === undefined) {
      lastError = new Error(`Temporal model provider "${provider}" is not configured.`);
      if (strategy === 'fallback') continue;
      throw lastError;
    }
    const requiredCapabilities = routeAgent.model.capabilities ?? [];
    const supportedCapabilities = client.capabilities ?? [];
    const missing = requiredCapabilities.filter((capability) => !supportedCapabilities.includes(capability));
    if (missing.length > 0) {
      lastError = new Error(`Provider "${provider}" does not support required capabilities: ${missing.join(', ')}.`);
      if (strategy === 'fallback') continue;
      throw lastError;
    }
    try {
      const result = await client.chat({ agent: routeAgent, goal, signal, traceId });
      if (strategy === 'ensemble') results.push({ provider, result, routeIndex: index });
      else return [{ provider, result, routeIndex: index }];
    } catch (error) {
      lastError = error;
      if (strategy !== 'fallback' && strategy !== 'ensemble') throw error;
    }
  }
  if (results.length > 0) {
    if (strategy !== 'ensemble' || results.length === 1) return results;
    const first = results[0]!;
    return [{ provider: results.map((value) => value.provider).join(','), routeIndex: first.routeIndex, result: { ...first.result, content: results.map((value) => `[${value.provider}] ${value.result.content}`).join('\n\n') } }];
  }
  throw lastError instanceof Error ? lastError : new Error(`Agent "${agent.id}" did not produce a model result.`);
}

function parseAgentDefinition(value: unknown): AgentDefinition | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AgentDefinition>;
  if (typeof candidate.id !== 'string' || typeof candidate.version !== 'number' || candidate.model === undefined || candidate.limits === undefined || candidate.boundaries === undefined || candidate.tools === undefined) return undefined;
  return candidate as AgentDefinition;
}

function ollamaAdapter(client: OllamaClient): TemporalModelClient {
  return {
    provider: 'ollama',
    capabilities: ['text', 'usage'],
    chat: async (input) => {
      const result = await client.chat(input);
      return result;
    },
  };
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
