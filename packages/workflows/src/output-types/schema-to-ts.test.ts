import { describe, expect, test } from 'bun:test';
import { convertOutputSchema, UnsupportedSchemaError } from './schema-to-ts';

function unsupported(schema: unknown): UnsupportedSchemaError {
  try {
    convertOutputSchema(schema);
  } catch (error) {
    if (error instanceof UnsupportedSchemaError) return error;
    throw error;
  }
  throw new Error('the schema converted');
}

describe('convertOutputSchema', () => {
  test('an object marks undeclared-required properties optional and keeps schema order', () => {
    const { type } = convertOutputSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        zeta: { type: 'string', pattern: '\\S' },
        count: { type: 'integer', minimum: 1 },
        ratio: { type: 'number' },
        'needs-quote': { type: 'boolean' },
      },
      required: ['zeta', 'count'],
    });
    expect(type).toBe(
      [
        '{',
        '  readonly zeta: string;',
        '  readonly count: number;',
        '  readonly ratio?: number;',
        "  readonly 'needs-quote'?: boolean;",
        '}',
      ].join('\n')
    );
  });

  test('a type list is a union, and a nullable object keeps its properties', () => {
    expect(convertOutputSchema({ type: ['string', 'null'] }).type).toBe('string | null');
    expect(
      convertOutputSchema({
        type: ['object', 'null'],
        properties: { a: { type: 'string' } },
        required: ['a'],
      }).type
    ).toBe('{\n  readonly a: string;\n} | null');
  });

  test('arrays nest their item type, indented with the property that holds them', () => {
    const { type } = convertOutputSchema({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
        bare: { type: 'array' },
      },
      required: ['items', 'bare'],
    });
    expect(type).toBe(
      [
        '{',
        '  readonly items: ReadonlyArray<{',
        '    readonly id: string;',
        '  }>;',
        '  readonly bare: ReadonlyArray<unknown>;',
        '}',
      ].join('\n')
    );
  });

  test('enum and const are literal types, and every enum is recorded by its path', () => {
    const { type, enums } = convertOutputSchema({
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['launch', "it's"] },
        trust: { type: ['string', 'null'], enum: ['maintainer', null] },
        kind: { const: 'fixed' },
        choices: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'object', properties: { effect: { enum: [1, 2] } }, required: ['effect'] },
              { type: 'null' },
            ],
          },
        },
      },
      required: ['decision', 'trust', 'kind', 'choices'],
    });
    expect(type).toBe(
      [
        '{',
        "  readonly decision: 'launch' | 'it\\'s';",
        "  readonly trust: 'maintainer' | null;",
        "  readonly kind: 'fixed';",
        '  readonly choices: ReadonlyArray<{',
        '    readonly effect: 1 | 2;',
        '  } | null>;',
        '}',
      ].join('\n')
    );
    expect([...enums]).toEqual([
      ['decision', ['launch', "it's"]],
      ['trust', ['maintainer', null]],
      ['choices[].anyOf[0].effect', [1, 2]],
    ]);
  });

  test('a root enum is recorded under $, also beside a const', () => {
    expect([...convertOutputSchema({ enum: ['a', 'b'] }).enums]).toEqual([['$', ['a', 'b']]]);
    const beside = convertOutputSchema({ const: 'a', enum: ['a', 'b'] });
    expect(beside.type).toBe("'a'");
    expect([...beside.enums]).toEqual([['$', ['a', 'b']]]);
  });

  test('oneOf is a union of its alternatives', () => {
    expect(
      convertOutputSchema({ oneOf: [{ type: 'integer' }, { type: 'string', enum: ['none'] }] }).type
    ).toBe("number | 'none'");
  });

  test('an object that declares no property is a record of its additionalProperties', () => {
    expect(convertOutputSchema({ type: 'object' }).type).toBe('Readonly<Record<string, unknown>>');
    expect(
      convertOutputSchema({ type: 'object', additionalProperties: { type: 'integer' } }).type
    ).toBe('Readonly<Record<string, number>>');
    expect(
      convertOutputSchema({ type: 'object', properties: {}, additionalProperties: false }).type
    ).toBe('Readonly<Record<string, never>>');
  });

  test('an unconstrained schema is unknown, never any', () => {
    expect(convertOutputSchema({}).type).toBe('unknown');
    expect(convertOutputSchema({ description: 'anything' }).type).toBe('unknown');
    expect(convertOutputSchema(true).type).toBe('unknown');
    expect(convertOutputSchema(false).type).toBe('never');
  });

  test.each([
    ['$ref', { $ref: '#/$defs/a' }, '$'],
    ['allOf', { type: 'object', properties: { a: { allOf: [{ type: 'string' }] } } }, 'a'],
    ['not', { type: 'array', items: { not: { type: 'null' } } }, '$[]'],
    ['patternProperties', { type: 'object', patternProperties: {} }, '$'],
    ['if', { anyOf: [{ type: 'string' }, { if: {} }] }, 'anyOf[1]'],
    [
      'allOf',
      { const: 'x', type: 'object', properties: { a: { allOf: [{ type: 'string' }] } } },
      'a',
    ],
  ])('refuses %s by name and path', (keyword, schema, path) => {
    const error = unsupported(schema);
    expect(error.keyword).toBe(keyword);
    expect(error.schemaPath).toBe(path);
  });

  test.each([
    ['properties without a type', { properties: { a: { type: 'string' } } }, 'properties'],
    ['items without a type', { items: { type: 'string' } }, 'items'],
    ['items on a non-array', { type: 'string', items: { type: 'string' } }, 'items'],
    ['tuple items', { type: 'array', items: [{ type: 'string' }] }, 'items'],
    ['tuple items beside an enum', { type: 'array', enum: [1], items: [{}] }, 'items'],
    ['a type beside anyOf', { type: 'object', anyOf: [{ type: 'object' }] }, 'type'],
    ['an unknown type name', { type: 'date' }, 'type'],
    ['an object enum value', { enum: [{ a: 1 }] }, 'enum'],
    [
      'a required name properties does not declare',
      { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
      'required',
    ],
    [
      'a schema for additionalProperties beside properties',
      { type: 'object', properties: { a: {} }, additionalProperties: { type: 'string' } },
      'additionalProperties',
    ],
  ])('refuses %s', (_name, schema, keyword) => {
    expect(unsupported(schema).keyword).toBe(keyword);
  });
});
