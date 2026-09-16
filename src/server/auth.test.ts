import { describe, expect, it } from 'vitest';

import { Authenticator, parseAuthTokens } from './auth.js';

describe('Authenticator', () => {
  const tokens = [{ token: 'author-secret', principal: { id: 'author-1', role: 'author' as const, tenantIds: ['tenant-a'], projectIds: ['project-a'] } }];

  it('keeps local development permissive while required mode rejects anonymous requests', () => {
    const local = new Authenticator('local');
    expect(local.authorize(local.authenticate(undefined), { method: 'GET', url: '/api/workflows', tenantId: 'any', projectId: 'any' }).allowed).toBe(true);
    const required = new Authenticator('required', tokens);
    expect(required.authenticate(undefined)).toBeUndefined();
    expect(required.authorize(undefined, { method: 'GET', url: '/api/workflows', tenantId: 'tenant-a', projectId: 'project-a' })).toMatchObject({ allowed: false, requiredRole: 'reader' });
  });

  it('enforces role and tenant/project scope for write operations', () => {
    const authenticator = new Authenticator('required', tokens);
    const principal = authenticator.authenticate('Bearer author-secret');
    expect(authenticator.authorize(principal, { method: 'POST', url: '/api/projects', tenantId: 'tenant-a', projectId: 'project-a' }).allowed).toBe(true);
    expect(authenticator.authorize(principal, { method: 'POST', url: '/api/deployments/demo/action', tenantId: 'tenant-a', projectId: 'project-a' })).toMatchObject({ allowed: false, requiredRole: 'operator' });
    expect(authenticator.authorize(principal, { method: 'POST', url: '/api/workflows/demo/runs', tenantId: 'tenant-a', projectId: 'project-a' })).toMatchObject({ allowed: false, requiredRole: 'operator' });
    expect(authenticator.authorize(principal, { method: 'GET', url: '/api/workflows', tenantId: 'tenant-b', projectId: 'project-a' })).toMatchObject({ allowed: false, reason: expect.stringContaining('not authorized') });
    const operator = new Authenticator('required', [{ token: 'operator-secret', principal: { id: 'operator-1', role: 'operator', tenantIds: ['tenant-a'], projectIds: ['project-a'] } }]).authenticate('Bearer operator-secret');
    expect(new Authenticator('required', []).authorize(operator, { method: 'POST', url: '/api/projects', tenantId: 'tenant-a', projectId: 'project-a' }).allowed).toBe(false);
  });

  it('parses only valid token definitions and never exposes token values in decisions', () => {
    const parsed = parseAuthTokens(JSON.stringify([
      { token: 'reader-secret', principal: { id: 'reader', role: 'reader', tenantIds: ['tenant-a'], projectIds: ['*'] } },
      { token: '', principal: { id: 'invalid', role: 'reader', tenantIds: [], projectIds: [] } },
      { token: 'bad-shape', principal: { id: 'invalid', role: 'unknown', tenantIds: [], projectIds: [] } },
    ]));
    expect(parsed).toHaveLength(1);
    const authenticator = new Authenticator('required', parsed);
    const decision = authenticator.authorize(authenticator.authenticate('Bearer wrong'), { method: 'GET', url: '/api/workflows', tenantId: 'tenant-a', projectId: 'project-a' });
    expect(JSON.stringify(decision)).not.toContain('reader-secret');
  });
});
