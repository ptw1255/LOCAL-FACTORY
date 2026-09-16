import { timingSafeEqual } from 'node:crypto';

export type AuthMode = 'local' | 'required';
export type AuthRole = 'reader' | 'author' | 'operator' | 'reviewer' | 'admin';

export interface AuthPrincipal {
  id: string;
  role: AuthRole;
  tenantIds: string[];
  projectIds: string[];
}

export interface AuthToken {
  token: string;
  principal: AuthPrincipal;
}

export interface AuthRequestInfo {
  method: string;
  url: string;
  tenantId: string;
  projectId: string;
}

export interface AuthDecision {
  allowed: boolean;
  principal?: AuthPrincipal;
  reason: string;
  requiredRole: AuthRole;
}

/** Small token authenticator for local development and self-hosted deployments. */
export class Authenticator {
  public constructor(
    private readonly mode: AuthMode = 'local',
    private readonly tokens: readonly AuthToken[] = [],
  ) {}

  public authenticate(authorization: string | undefined): AuthPrincipal | undefined {
    if (authorization === undefined || authorization.trim() === '') {
      if (this.mode === 'required') return undefined;
      return { id: 'local-admin', role: 'admin', tenantIds: ['*'], projectIds: ['*'] };
    }
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1] === undefined) return undefined;
    const supplied = match[1].trim();
    return this.tokens.find((candidate) => secureEqual(candidate.token, supplied))?.principal;
  }

  public authorize(principal: AuthPrincipal | undefined, request: AuthRequestInfo): AuthDecision {
    const requiredRole = roleForRequest(request.method, request.url);
    if (principal === undefined) return { allowed: false, reason: 'Authentication is required.', requiredRole };
    if (!scopeAllowed(principal.tenantIds, request.tenantId) || !scopeAllowed(principal.projectIds, request.projectId)) {
      return { allowed: false, principal, reason: 'The principal is not authorized for this tenant or project.', requiredRole };
    }
    if (!roleAllows(principal.role, requiredRole)) {
      return { allowed: false, principal, reason: `The ${requiredRole} role is required for this operation.`, requiredRole };
    }
    return { allowed: true, principal, reason: 'Authorized.', requiredRole };
  }
}

function roleAllows(actual: AuthRole, required: AuthRole): boolean {
  if (actual === 'admin' || required === 'reader') return true;
  return actual === required;
}

export function parseAuthTokens(value: string | undefined): AuthToken[] {
  if (value === undefined || value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (candidate === null || typeof candidate !== 'object') return [];
      const item = candidate as { token?: unknown; principal?: unknown };
      if (typeof item.token !== 'string' || item.token.trim() === '' || item.principal === null || typeof item.principal !== 'object') return [];
      const principal = item.principal as Partial<AuthPrincipal>;
      if (typeof principal.id !== 'string' || !isRole(principal.role) || !Array.isArray(principal.tenantIds) || !Array.isArray(principal.projectIds)) return [];
      if (!principal.tenantIds.every((entry) => typeof entry === 'string') || !principal.projectIds.every((entry) => typeof entry === 'string')) return [];
      return [{ token: item.token, principal: { id: principal.id, role: principal.role, tenantIds: [...principal.tenantIds], projectIds: [...principal.projectIds] } }];
    });
  } catch {
    return [];
  }
}

function roleForRequest(method: string, url: string): AuthRole {
  if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') return 'reader';
  if (/\/runs\/[^/]+\/(approve|deny|expire|supersede)/.test(url)) return 'reviewer';
  if (/\/runs\/[^/]+\/(cancel|retry|resume|replay)|\/workflows\/[^/]+\/runs(?:\/|$)|\/deployments(?:\/|$)|\/repository(?:\/|$)/.test(url)) return 'operator';
  if (/\/tenants(?:\/|$)|\/connections(?:\/|$)/.test(url)) return 'admin';
  return 'author';
}

function scopeAllowed(allowed: readonly string[], requested: string): boolean {
  return allowed.includes('*') || allowed.includes(requested);
}

function isRole(value: unknown): value is AuthRole {
  return value === 'reader' || value === 'author' || value === 'operator' || value === 'reviewer' || value === 'admin';
}

function secureEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
