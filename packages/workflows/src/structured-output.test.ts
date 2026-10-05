import { describe, expect, test } from 'bun:test';
import {
  compileOutputSchema,
  validateStructuredOutput,
  formatSchemaErrors,
} from './structured-output';

describe('validateStructuredOutput', () => {
  const schema = {
    type: 'object',
    properties: { summary: { type: 'string' }, count: { type: 'number' } },
    required: ['summary'],
  };

  test('valid value passes', () => {
    const r = validateStructuredOutput({ summary: 'hi', count: 2 }, schema);
    expect(r.valid).toBe(true);
  });

  test('missing required field fails with a root-level error', () => {
    const r = validateStructuredOutput({ count: 2 }, schema);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some(e => e.includes('summary'))).toBe(true);
  });

  test('wrong type fails with a path-scoped error', () => {
    const r = validateStructuredOutput({ summary: 'hi', count: 'two' }, schema);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some(e => e.startsWith('/count'))).toBe(true);
  });

  test('enum violation fails', () => {
    const enumSchema = { type: 'object', properties: { kind: { enum: ['A', 'B'] } } };
    expect(validateStructuredOutput({ kind: 'C' }, enumSchema).valid).toBe(false);
    expect(validateStructuredOutput({ kind: 'A' }, enumSchema).valid).toBe(true);
  });

  test.each([
    { type: 'object', properties: { verdict: { type: 'string' } } },
    { type: 'object', properties: { verdict: { type: 'string' } }, verdict: '...' },
  ])('rejects schema-echo payload %j against a tight contract', echo => {
    const tightSchema = {
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['review', 'skip'] } },
      required: ['verdict'],
    };
    expect(validateStructuredOutput(echo, tightSchema).valid).toBe(false);
    expect(validateStructuredOutput({ verdict: 'review' }, tightSchema).valid).toBe(true);
  });

  test('optional field absent is still valid (additionalProperties not required)', () => {
    expect(validateStructuredOutput({ summary: 'hi' }, schema).valid).toBe(true);
  });

  test('uncompilable schema judges nothing (valid:true) and reports via onCompileError', () => {
    let compileError: string | undefined;
    // `$ref` to a non-existent definition makes ajv.compile throw. The caller
    // (dag-executor) turns this into a node failure — see compileOutputSchema.
    const broken = { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } };
    const r = validateStructuredOutput({ a: 1 }, broken, msg => {
      compileError = msg;
    });
    expect(r.valid).toBe(true);
    expect(compileError).toBeDefined();
  });
});

describe('compileOutputSchema', () => {
  test('returns null for a compilable schema', () => {
    expect(
      compileOutputSchema({
        type: 'object',
        properties: { ready: { type: 'boolean' } },
        required: ['ready'],
      })
    ).toBeNull();
  });

  test('returns the ajv message for a schema it rejects', () => {
    const message = compileOutputSchema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/missing' } },
    });
    expect(message).not.toBeNull();
    expect(message).toContain('missing');
  });

  test('tolerated dialect annotations still compile (ajv strict: false)', () => {
    // Unknown keyword + unknown format: ignored, not rejected — an author schema
    // carrying these must keep loading.
    expect(
      compileOutputSchema({
        type: 'object',
        title: 'Result',
        properties: { when: { type: 'string', format: 'not-a-known-format' } },
        'x-archon-note': 'annotation',
      })
    ).toBeNull();
  });

  test('a compiled schema is reused by validateStructuredOutput', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    };
    expect(compileOutputSchema(schema)).toBeNull();

    let compileError: string | undefined;
    const ok = validateStructuredOutput({ n: 1 }, schema, msg => {
      compileError = msg;
    });
    const bad = validateStructuredOutput({ n: 'one' }, schema);
    expect(compileError).toBeUndefined();
    expect(ok.valid).toBe(true);
    expect(bad.valid).toBe(false);
  });

  test('an equivalent schema object declaring the same $id still compiles', () => {
    // The loader compiles a node's schema, then the executor compiles the object
    // that reached it (a re-parse of the file, or an include-expanded clone). Both
    // must succeed: a `$id` left registered process-wide would make the second one
    // throw `schema with key or id ... already exists`, and a compile failure is
    // now fatal.
    const first = { $id: 'https://example.test/result.json', type: 'object' };
    const second = { $id: 'https://example.test/result.json', type: 'object' };
    expect(compileOutputSchema(first)).toBeNull();
    expect(compileOutputSchema(second)).toBeNull();
    expect(validateStructuredOutput({ any: true }, second).valid).toBe(true);
  });
});

describe('compileOutputSchema registry hygiene', () => {
  test('a failed compile does not leave its $id registered for the next attempt', () => {
    // ajv registers `$id` before resolving references, so the dangling `$ref` throws
    // with the id already in the registry. The author's corrected schema, a distinct
    // object with the same `$id`, must then get a clean compile rather than
    // "schema with key or id ... already exists".
    const broken = {
      $id: 'https://example.test/broken.json',
      type: 'object',
      properties: { a: { $ref: '#/$defs/missing' } },
    };
    const fixed = {
      $id: 'https://example.test/broken.json',
      type: 'object',
      properties: { a: { type: 'string' } },
    };
    expect(compileOutputSchema(broken)).toContain("can't resolve reference");
    expect(compileOutputSchema(fixed)).toBeNull();
    expect(validateStructuredOutput({ a: 'x' }, fixed).valid).toBe(true);
  });
});

describe('formatSchemaErrors', () => {
  test('renders root-level missing-property failures with the property name', () => {
    const r = validateStructuredOutput(
      {},
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    );
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.errors.some(line => line.startsWith('(root):') && line.includes('name'))).toBe(true);
  });

  test('returns a generic line for null/empty error input', () => {
    expect(formatSchemaErrors(null)).toEqual(['value does not match the declared schema']);
    expect(formatSchemaErrors([])).toEqual(['value does not match the declared schema']);
  });
});
