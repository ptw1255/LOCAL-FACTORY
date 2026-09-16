export interface PolicyRule {
  effect: 'allow' | 'deny';
  /** A single action pattern; `actions` is accepted for concise policy files. */
  action?: string;
  actions?: string[];
  nodeTypes?: string[];
  operation?: string;
}

export interface PolicyContext {
  action: string;
  nodeType?: string;
  operation?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  matchedRule?: PolicyRule;
  reason?: string;
}

function matches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedPattern === '' || normalizedPattern === '*') return true;
  if (!normalizedPattern.includes('*')) return normalizedPattern === normalizedValue;
  const prefix = normalizedPattern.slice(0, normalizedPattern.indexOf('*'));
  return normalizedValue.startsWith(prefix);
}

function ruleMatches(rule: PolicyRule, context: PolicyContext): boolean {
  const actions = rule.actions ?? (rule.action === undefined ? undefined : [rule.action]);
  const actionMatches = actions === undefined || actions.length === 0
    ? true
    : actions.some((action) => matches(action, context.action));
  const nodeMatches = rule.nodeTypes === undefined || rule.nodeTypes.length === 0 || (context.nodeType !== undefined && rule.nodeTypes.some((nodeType) => matches(nodeType, context.nodeType!)));
  const operationMatches = rule.operation === undefined || (context.operation !== undefined && matches(rule.operation, context.operation));
  return actionMatches && nodeMatches && operationMatches;
}

/** Evaluate a small deterministic allow/deny policy. Deny wins; when any
 * allow rule exists, an action must match an allow rule to proceed. */
export function evaluatePolicy(rules: unknown, context: PolicyContext): PolicyDecision {
  if (!Array.isArray(rules) || rules.length === 0) return { allowed: true };
  const validRules = rules.filter((rule): rule is PolicyRule =>
    rule !== null && typeof rule === 'object'
    && ((rule as { effect?: unknown }).effect === 'allow' || (rule as { effect?: unknown }).effect === 'deny'),
  );
  const matched = validRules.filter((rule) => ruleMatches(rule, context));
  const denied = matched.find((rule) => rule.effect === 'deny');
  if (denied !== undefined) return { allowed: false, matchedRule: denied, reason: `Policy denied action ${context.action}.` };
  const allows = validRules.filter((rule) => rule.effect === 'allow');
  if (allows.length > 0 && !matched.some((rule) => rule.effect === 'allow')) return { allowed: false, reason: `Policy has no allow rule for action ${context.action}.` };
  return { allowed: true, matchedRule: matched.find((rule) => rule.effect === 'allow') };
}

export class PolicyDeniedError extends Error {
  public readonly code = 'POLICY_DENIED';

  public constructor(message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}
