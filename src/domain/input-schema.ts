import type { SourceDiagnostic } from './types.js';

/**
 * The workflow input contract is intentionally a small JSON-Schema subset.
 * Keeping this validator local means a run can be rejected before any unit,
 * provider, or repository side effect occurs without introducing another
 * runtime dependency or accepting arbitrary executable validation code.
 */
export interface WorkflowInputValidationResult {
  valid: boolean;
  issues: SourceDiagnostic[];
}

type JsonSchema = Record<string, unknown>;

function pathLabel(path: string): string {
  return path === '$' ? 'workflow input' : `workflow input${path.slice(1)}`;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function addIssue(issues: SourceDiagnostic[], path: string, message: string): void {
  issues.push({
    severity: 'error',
    path: 'workflow.input',
    line: 1,
    column: 1,
    code: 'run.input.invalid',
    message: `${pathLabel(path)} ${message}`,
  });
}

function validateSchema(value: unknown, schema: JsonSchema, path: string, issues: SourceDiagnostic[]): void {
  const declaredType = schema.type;
  if (typeof declaredType === 'string' && !typeMatches(value, declaredType)) {
    addIssue(issues, path, `must be ${declaredType}.`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    addIssue(issues, path, 'must match one of the declared enum values.');
  }

  if (typeof schema.const !== 'undefined' && !Object.is(schema.const, value)) {
    addIssue(issues, path, 'must match the declared constant.');
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) addIssue(issues, path, `must contain at least ${schema.minLength} characters.`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) addIssue(issues, path, `must contain at most ${schema.maxLength} characters.`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) addIssue(issues, path, `must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) addIssue(issues, path, `must be at most ${schema.maximum}.`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) addIssue(issues, path, `must contain at least ${schema.minItems} items.`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) addIssue(issues, path, `must contain at most ${schema.maxItems} items.`);
    if (schema.items !== null && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, index) => validateSchema(item, schema.items as JsonSchema, `${path}[${index}]`, issues));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
    for (const key of required) {
      if (!(key in objectValue)) addIssue(issues, `${path}.${key}`, 'is required.');
    }
    const properties = schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    for (const [key, child] of Object.entries(objectValue)) {
      const childSchema = properties[key];
      if (childSchema !== null && typeof childSchema === 'object' && !Array.isArray(childSchema)) {
        validateSchema(child, childSchema as JsonSchema, `${path}.${key}`, issues);
      } else if (schema.additionalProperties === false && Object.keys(properties).length > 0) {
        addIssue(issues, `${path}.${key}`, 'is not declared in the input schema.');
      }
    }
  }
}

export function validateWorkflowInput(schema: Record<string, unknown> | undefined, value: unknown): WorkflowInputValidationResult {
  if (schema === undefined || Object.keys(schema).length === 0) return { valid: true, issues: [] };
  const issues: SourceDiagnostic[] = [];
  validateSchema(value, schema, '$', issues);
  return { valid: issues.length === 0, issues };
}

