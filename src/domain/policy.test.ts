import { describe, expect, it } from 'vitest';

import { evaluatePolicy } from './policy.js';

describe('policy evaluation', () => {
  it('allows actions by default and denies matching rules', () => {
    expect(evaluatePolicy(undefined, { action: 'output' }).allowed).toBe(true);
    expect(evaluatePolicy([{ effect: 'deny', action: 'repositoryPush' }], { action: 'repositoryPush' })).toMatchObject({ allowed: false });
  });

  it('requires an allow rule when an allow list is present and supports wildcards', () => {
    const rules = [{ effect: 'allow', actions: ['repository*'] }, { effect: 'deny', action: 'repositoryPush' }];
    expect(evaluatePolicy(rules, { action: 'repositoryCheck' }).allowed).toBe(true);
    expect(evaluatePolicy(rules, { action: 'repositoryPush' }).allowed).toBe(false);
    expect(evaluatePolicy(rules, { action: 'output' })).toMatchObject({ allowed: false, reason: expect.stringContaining('no allow rule') });
  });
});
