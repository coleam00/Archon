import { describe, expect, test } from 'bun:test';
import {
  findPreparedStrictSchemaIssues,
  normalizeJsonSchemaForOpenAiStrict,
} from './strict-output-schema';

describe('required fields forbidden by strict closure', () => {
  for (const keyword of ['oneOf', 'anyOf']) {
    test.each([undefined, false, true])(
      `names the enclosing forbidden field before completing ${keyword} (additionalProperties %s)`,
      additionalProperties => {
        const schema = {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a', 'b'],
          [keyword]: [{ properties: { a: { const: 'ok' } } }],
          ...(additionalProperties === undefined ? {} : { additionalProperties }),
        };
        expect(findPreparedStrictSchemaIssues(schema)).toEqual([
          {
            kind: 'unsupported-conversion',
            schemaPath: 'output_format',
            message: expect.stringMatching(
              /output_format.required.*b.*properties.*additionalProperties: false/
            ),
          },
        ]);
      }
    );
  }

  test.each([undefined, false, true])(
    'refuses undeclared required fields with authored additionalProperties %s',
    additionalProperties => {
      const schema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'b', 'c'],
        ...(additionalProperties === undefined ? {} : { additionalProperties }),
      };
      const original = structuredClone(schema);
      expect(() => normalizeJsonSchemaForOpenAiStrict(schema)).toThrow(
        /output_format.required.*b, c.*properties.*additionalProperties: false/
      );
      expect(findPreparedStrictSchemaIssues(schema)).toEqual([
        {
          kind: 'unsupported-conversion',
          schemaPath: 'output_format',
          message: expect.stringMatching(
            /output_format.required.*b, c.*properties.*additionalProperties: false/
          ),
        },
      ]);
      expect(schema).toEqual(original);
    }
  );

  test('reports the nested object path and does not mistake inherited keys for properties', () => {
    const schema = {
      type: 'object',
      properties: {
        inner: { properties: { a: {} }, required: ['a', 'toString'] },
      },
      required: ['inner'],
    };
    expect(() => normalizeJsonSchemaForOpenAiStrict(schema)).toThrow(
      /output_format.properties.inner.required.*toString/
    );
  });

  test('preserves matching properties, required names and strict closure', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    };
    expect(normalizeJsonSchemaForOpenAiStrict(schema)).toEqual({
      ...schema,
      additionalProperties: false,
    });
    expect(findPreparedStrictSchemaIssues(schema)).toEqual([]);
  });
});
