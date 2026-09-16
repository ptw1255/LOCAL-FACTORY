import { describe, expect, it } from 'vitest';

import { validateWorkflowInput } from './input-schema.js';

describe('workflow input schema validation', () => {
  const schema = {
    type: 'object',
    required: ['request', 'priority'],
    additionalProperties: false,
    properties: {
      request: { type: 'string', minLength: 3 },
      priority: { type: 'integer', minimum: 1, maximum: 5 },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };

  it('accepts a valid structured input', () => {
    expect(validateWorkflowInput(schema, { request: 'Fix login', priority: 2, tags: ['auth'] })).toEqual({ valid: true, issues: [] });
  });

  it('reports required, type, and unknown fields', () => {
    const result = validateWorkflowInput(schema, { request: 'x', priority: 9, extra: true });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      'workflow input.request must contain at least 3 characters.',
      'workflow input.priority must be at most 5.',
      'workflow input.extra is not declared in the input schema.',
    ]);
  });

  it('supports primitive schemas and optional contracts', () => {
    expect(validateWorkflowInput({ type: 'string' }, 'hello').valid).toBe(true);
    expect(validateWorkflowInput({ type: 'string' }, 1).valid).toBe(false);
    expect(validateWorkflowInput(undefined, { anything: true })).toEqual({ valid: true, issues: [] });
  });
});

