import { createHash } from 'node:crypto';

import type { WorkflowNode } from '../domain/types.js';

export interface DeliveryIssueRef {
  number: number;
  title: string;
  repository: string;
}

export interface DeliveryMutation {
  operation: 'create' | 'replace' | 'delete' | 'rename';
  path: string;
  newPath?: string;
  content?: string;
  expectedSha256?: string;
}

export interface DeliveryActionPlan {
  version: 1;
  issue: DeliveryIssueRef;
  repository: { owner: string; name: string; baseRevision: string };
  tasks: Array<{ id: string; title: string; dependsOn?: string[] }>;
  mutations: DeliveryMutation[];
  checks: string[];
  branch: { name: string };
  commit: { message: string; paths: string[] };
  pullRequest: { title: string; body: string; base: string };
  source: { agentId: string; model: string; artifactId?: string };
  policyVersion: string;
}

export interface DeliveryBindingContext {
  input?: unknown;
  outputs?: Record<string, unknown>;
  plan?: DeliveryActionPlan;
  issue?: DeliveryIssueRef;
  repository?: DeliveryActionPlan['repository'];
}

const SAFE_CHECKS = new Set(['npm test', 'npm run test:integration', 'npm run lint', 'npm run typecheck', 'npm run build', 'node --version']);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;
const HASH = /^[a-f0-9]{64}$/i;

function string(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters.`);
  return value;
}

function relativePath(value: unknown, label: string): string {
  const path = string(value, label, 500).replaceAll('\\', '/');
  if (path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`${label} must be a safe relative path.`);
  if (path.split('/').some((part) => part.startsWith('.env') || ['credentials', 'secrets'].includes(part.toLowerCase()))) throw new Error(`${label} cannot target secret-bearing paths.`);
  return path;
}

function repository(value: unknown): DeliveryActionPlan['repository'] {
  if (value === null || typeof value !== 'object') throw new Error('DeliveryActionPlan.repository is required.');
  const candidate = value as Record<string, unknown>;
  const owner = string(candidate.owner, 'repository.owner', 100);
  const name = string(candidate.name, 'repository.name', 100);
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(name)) throw new Error('repository.owner and repository.name contain unsafe characters.');
  const baseRevision = string(candidate.baseRevision, 'repository.baseRevision', 80);
  if (!/^[a-f0-9]{7,64}$/i.test(baseRevision)) throw new Error('repository.baseRevision must be a Git commit SHA.');
  return { owner, name, baseRevision };
}

/** Validate and normalize the only model-produced object allowed to drive delivery side effects. */
export function validateDeliveryActionPlan(value: unknown): DeliveryActionPlan {
  if (value === null || typeof value !== 'object') throw new Error('DeliveryActionPlan must be an object.');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error('DeliveryActionPlan.version must be 1.');
  if (candidate.issue === null || typeof candidate.issue !== 'object') throw new Error('DeliveryActionPlan.issue is required.');
  const issue = candidate.issue as Record<string, unknown>;
  if (!Number.isSafeInteger(issue.number) || Number(issue.number) < 1) throw new Error('issue.number must be a positive integer.');
  const issueRef: DeliveryIssueRef = { number: Number(issue.number), title: string(issue.title, 'issue.title', 300), repository: string(issue.repository, 'issue.repository', 220) };
  const repo = repository(candidate.repository);
  if (issueRef.repository !== `${repo.owner}/${repo.name}`) throw new Error('issue.repository must match repository.owner/name.');
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length < 1 || candidate.tasks.length > 128) throw new Error('tasks must contain between 1 and 128 items.');
  const taskIds = new Set<string>();
  const tasks = candidate.tasks.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`tasks[${index}] must be an object.`);
    const task = item as Record<string, unknown>;
    const id = string(task.id, `tasks[${index}].id`, 100);
    if (!SAFE_SEGMENT.test(id) || taskIds.has(id)) throw new Error(`tasks[${index}].id must be unique and safe.`);
    taskIds.add(id);
    const dependsOn = task.dependsOn === undefined ? undefined : Array.isArray(task.dependsOn) ? task.dependsOn.map((dep) => string(dep, `tasks[${index}].dependsOn`, 100)) : (() => { throw new Error(`tasks[${index}].dependsOn must be an array.`); })();
    return { id, title: string(task.title, `tasks[${index}].title`, 300), ...(dependsOn === undefined ? {} : { dependsOn }) };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!taskIds.has(dependency)) throw new Error(`tasks.${task.id}.dependsOn references an unknown task.`);
    }
  }
  const mutationsValue = candidate.mutations;
  if (!Array.isArray(mutationsValue) || mutationsValue.length > 128) throw new Error('mutations must be an array with at most 128 items.');
  const mutations = mutationsValue.map((item, index): DeliveryMutation => {
    if (item === null || typeof item !== 'object') throw new Error(`mutations[${index}] must be an object.`);
    const mutation = item as Record<string, unknown>;
    const operation = mutation.operation;
    if (operation !== 'create' && operation !== 'replace' && operation !== 'delete' && operation !== 'rename') throw new Error(`mutations[${index}].operation is invalid.`);
    const result: DeliveryMutation = { operation, path: relativePath(mutation.path, `mutations[${index}].path`) };
    if (operation === 'rename') result.newPath = relativePath(mutation.newPath, `mutations[${index}].newPath`);
    if (operation !== 'delete') result.content = string(mutation.content, `mutations[${index}].content`, 1_000_000);
    if (mutation.expectedSha256 !== undefined) {
      if (typeof mutation.expectedSha256 !== 'string' || !HASH.test(mutation.expectedSha256)) throw new Error(`mutations[${index}].expectedSha256 must be a SHA-256 hash.`);
      result.expectedSha256 = mutation.expectedSha256.toLowerCase();
    }
    return result;
  });
  if (!Array.isArray(candidate.checks) || candidate.checks.length > 32 || candidate.checks.some((check) => typeof check !== 'string' || !SAFE_CHECKS.has(check))) throw new Error('checks contains an unsupported command.');
  const checks = candidate.checks.map((check) => check as string);
  const branchValue = candidate.branch;
  const branchName = branchValue !== null && typeof branchValue === 'object' ? (branchValue as Record<string, unknown>).name : undefined;
  if (typeof branchName !== 'string' || !SAFE_BRANCH.test(branchName) || branchName.includes('..')) throw new Error('branch.name is invalid.');
  const commitValue = candidate.commit;
  if (commitValue === null || typeof commitValue !== 'object') throw new Error('commit is required.');
  const commit = commitValue as Record<string, unknown>;
  if (!Array.isArray(commit.paths) || commit.paths.length > 128) throw new Error('commit.paths is invalid.');
  const commitPaths = commit.paths.map((pathValue, index) => relativePath(pathValue, `commit.paths[${index}]`));
  const commitPathSet = new Set(commitPaths);
  for (const mutation of mutations) {
    if (!commitPathSet.has(mutation.path) || (mutation.newPath !== undefined && !commitPathSet.has(mutation.newPath))) {
      throw new Error(`commit.paths must include every delivery mutation path (${mutation.path}).`);
    }
  }
  const prValue = candidate.pullRequest;
  if (prValue === null || typeof prValue !== 'object') throw new Error('pullRequest is required.');
  const pr = prValue as Record<string, unknown>;
  if (typeof pr.base !== 'string' || !SAFE_SEGMENT.test(pr.base)) throw new Error('pullRequest.base is invalid.');
  const sourceValue = candidate.source;
  if (sourceValue === null || typeof sourceValue !== 'object') throw new Error('source is required.');
  const source = sourceValue as Record<string, unknown>;
  return {
    version: 1,
    issue: issueRef,
    repository: repo,
    tasks,
    mutations,
    checks,
    branch: { name: branchName },
    commit: { message: string(commit.message, 'commit.message', 300), paths: commitPaths },
    pullRequest: { title: string(pr.title, 'pullRequest.title', 300), body: string(pr.body, 'pullRequest.body', 20_000), base: pr.base as string },
    source: { agentId: string(source.agentId, 'source.agentId', 100), model: string(source.model, 'source.model', 200), ...(source.artifactId === undefined ? {} : { artifactId: string(source.artifactId, 'source.artifactId', 200) }) },
    policyVersion: string(candidate.policyVersion, 'policyVersion', 100),
  };
}

export function deliveryActionPlanHash(plan: DeliveryActionPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function lookup(path: string, context: DeliveryBindingContext): unknown {
  if (!/^(input|outputs|plan|issue|repository)(\.[A-Za-z0-9_-]+)*$/.test(path)) throw new Error(`Binding "${path}" is not an allowed context path.`);
  const [root, ...parts] = path.split('.');
  let value: unknown = context[root as keyof DeliveryBindingContext];
  for (const part of parts) {
    if (value === null || typeof value !== 'object' || !(part in (value as Record<string, unknown>))) throw new Error(`Binding "${path}" could not be resolved.`);
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined) throw new Error(`Binding "${path}" could not be resolved.`);
  return value;
}

function bindValue(value: unknown, context: DeliveryBindingContext): unknown {
  if (Array.isArray(value)) return value.map((item) => bindValue(item, context));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, bindValue(child, context)]));
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  const exact = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
  if (exact !== null) return lookup(exact[1]!, context);
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
    const resolved = lookup(path.trim(), context);
    if (resolved !== null && typeof resolved === 'object') throw new Error(`Object binding "${path}" must occupy the complete value.`);
    return String(resolved);
  });
}

/** Resolve only the declarative `{{context.path}}` syntax; no shell or expression evaluation is permitted. */
export function bindWorkflowNode(node: WorkflowNode, context: DeliveryBindingContext): WorkflowNode {
  return { ...node, config: bindValue(node.config, context) as Record<string, unknown> };
}
