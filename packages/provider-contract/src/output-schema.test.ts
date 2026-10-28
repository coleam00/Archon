import { describe, expect, test } from 'bun:test';
import {
  findStrictSchemaIssues,
  isJsonSchemaCompositionKeyword,
  jsonSchemaChildren,
  visitJsonSchema,
} from './output-schema';

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

describe('schema edges', () => {
  test('classifies schema children and keeps data outside the traversal', () => {
    const leaf = { type: 'string' };
    const schema = {
      additionalProperties: leaf,
      unevaluatedProperties: leaf,
      propertyNames: leaf,
      contains: leaf,
      additionalItems: leaf,
      unevaluatedItems: leaf,
      not: leaf,
      if: leaf,
      then: leaf,
      else: leaf,
      contentSchema: leaf,
      items: [leaf, true],
      prefixItems: [leaf],
      allOf: [leaf, false],
      anyOf: [leaf],
      oneOf: [leaf],
      properties: { properties: leaf },
      patternProperties: { value: leaf },
      dependentSchemas: { value: leaf },
      dependencies: { value: leaf, propertyDependency: ['other'] },
      $defs: { value: leaf },
      definitions: { value: leaf },
      default: { properties: leaf },
      examples: [{ properties: leaf }],
    };
    const children = jsonSchemaChildren(schema, 'out');
    expect(children.map(({ path, relation }) => [path, relation])).toEqual([
      ['out.additionalProperties', 'nested'],
      ['out.unevaluatedProperties', 'nested'],
      ['out.propertyNames', 'nested'],
      ['out.contains', 'array-item'],
      ['out.additionalItems', 'array-item'],
      ['out.unevaluatedItems', 'array-item'],
      ['out.not', 'same-instance'],
      ['out.if', 'same-instance'],
      ['out.then', 'same-instance'],
      ['out.else', 'same-instance'],
      ['out.contentSchema', 'nested'],
      ['out.items[0]', 'array-item'],
      ['out.prefixItems[0]', 'array-item'],
      ['out.allOf[0]', 'composition'],
      ['out.anyOf[0]', 'composition'],
      ['out.oneOf[0]', 'composition'],
      ['out.properties.properties', 'nested'],
      ['out.patternProperties.value', 'nested'],
      ['out.dependentSchemas.value', 'dependency'],
      ['out.dependencies.value', 'dependency'],
      ['out.$defs.value', 'declaration'],
      ['out.definitions.value', 'declaration'],
    ]);
    const visited: string[] = [];
    visitJsonSchema(schema, 'out', (_, path) => visited.push(path));
    expect(visited).toEqual(['out', ...children.map(child => child.path)]);
    expect(Object.keys(schema).filter(isJsonSchemaCompositionKeyword)).toEqual([
      'allOf',
      'anyOf',
      'oneOf',
    ]);
    expect(jsonSchemaChildren({ items: leaf }, 'out')).toEqual([
      { node: leaf, path: 'out.items', relation: 'array-item', firstItem: 0, lastItem: Infinity },
    ]);
  });
});
