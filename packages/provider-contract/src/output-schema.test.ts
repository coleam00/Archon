import { describe, expect, test } from 'bun:test';
import { findStrictSchemaIssues } from './output-schema';

describe('findStrictSchemaIssues', () => {
  test('returns empty when required fully covers properties', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    };
    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([]);
  });

  test('reports a declared property missing from required', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    };
    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([
      { kind: 'missing-required', schemaPath: 'output_format', missing: ['b'] },
    ]);
  });

  test('reports multiple missing keys', () => {
    const schema = {
      type: 'object',
      properties: { x: {}, y: {}, z: {} },
      required: ['x'],
    };
    expect(findStrictSchemaIssues(schema, 'out')).toEqual([
      { kind: 'missing-required', schemaPath: 'out', missing: ['y', 'z'] },
    ]);
  });

  test('recurses into nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' } },
          required: ['a'],
        },
      },
      required: ['inner'],
    };
    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([
      {
        kind: 'missing-required',
        schemaPath: 'output_format.properties.inner',
        missing: ['b'],
      },
    ]);
  });

  test('reports a nested object without declared properties', () => {
    const schema = {
      type: 'object',
      properties: { pr: { type: 'object' } },
      required: ['pr'],
    };

    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([
      { kind: 'missing-properties', schemaPath: 'output_format.properties.pr' },
    ]);
  });

  test('accepts a fully required nullable object', () => {
    const schema = {
      type: ['object', 'null'],
      properties: {
        repo: {
          type: 'object',
          properties: { host: { type: 'string' }, path: { type: 'string' } },
          required: ['host', 'path'],
        },
        number: { type: 'integer' },
      },
      required: ['repo', 'number'],
    };

    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([]);
  });

  test('does not treat schema annotations or a properties map as subschemas', () => {
    const schema = {
      type: 'object',
      properties: {
        properties: { type: 'string' },
        config: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          default: { properties: { accidental: {} } },
          examples: [{ properties: { accidental: {} } }],
        },
      },
      required: ['properties', 'config'],
      default: { properties: { accidental: {} } },
      examples: [{ properties: { accidental: {} } }],
    };

    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([]);
  });

  test('recurses through JSON Schema subschema keywords', () => {
    const looseObject = { type: 'object', properties: { value: { type: 'string' } } };
    const schema = {
      allOf: [looseObject],
      anyOf: [true, { items: looseObject }],
      $defs: { nested: looseObject },
      dependentSchemas: { mode: looseObject },
    };

    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([
      { kind: 'missing-required', schemaPath: 'output_format.allOf[0]', missing: ['value'] },
      {
        kind: 'missing-required',
        schemaPath: 'output_format.anyOf[1].items',
        missing: ['value'],
      },
      {
        kind: 'missing-required',
        schemaPath: 'output_format.dependentSchemas.mode',
        missing: ['value'],
      },
      {
        kind: 'missing-required',
        schemaPath: 'output_format.$defs.nested',
        missing: ['value'],
      },
    ]);
  });

  test('skips nodes without properties (primitive leafs)', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'tags'],
    };
    expect(findStrictSchemaIssues(schema, 'o')).toEqual([]);
  });

  test('missing required key means all properties are missing from required', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
    };
    expect(findStrictSchemaIssues(schema, 'o')).toEqual([
      { kind: 'missing-required', schemaPath: 'o', missing: ['a'] },
    ]);
  });

  test('no crash on null', () => {
    expect(findStrictSchemaIssues(null, 'x')).toEqual([]);
  });

  test('no crash on arrays', () => {
    expect(
      findStrictSchemaIssues([{ type: 'object', properties: { a: {} }, required: [] }], 'x')
    ).toEqual([{ kind: 'missing-required', schemaPath: 'x[0]', missing: ['a'] }]);
  });

  test('no crash on primitive values', () => {
    expect(findStrictSchemaIssues('string', 'x')).toEqual([]);
    expect(findStrictSchemaIssues(42, 'x')).toEqual([]);
    expect(findStrictSchemaIssues(true, 'x')).toEqual([]);
  });

  test('basePath is prepended for meaningful root-relative paths', () => {
    const schema = { type: 'object', properties: { f: {} } };
    expect(findStrictSchemaIssues(schema, 'output_format')).toEqual([
      { kind: 'missing-required', schemaPath: 'output_format', missing: ['f'] },
    ]);
  });
});
