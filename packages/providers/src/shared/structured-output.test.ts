import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv2019 from 'ajv/dist/2019.js';
import {
  findStrictSchemaIssues,
  findPreparedStrictSchemaIssues,
  normalizeJsonSchemaForOpenAiStrict,
} from '@archon/provider-contract';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
  hasOpenAdditionalProperties,
} from './structured-output';

describe('augmentPromptForJsonSchema', () => {
  test('appends schema and JSON-only instruction', () => {
    const out = augmentPromptForJsonSchema('Summarise this text.', {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    expect(out).toContain('Summarise this text.');
    expect(out).toContain('CRITICAL: Respond with ONLY a JSON object');
    expect(out).toContain('No markdown code fences');
    expect(out).toContain('"title"');
  });
});

describe('tryParseStructuredOutput', () => {
  test('returns the parsed object for clean JSON', () => {
    expect(tryParseStructuredOutput('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  test('returns undefined for a top-level array (contract is a JSON object)', () => {
    // output_format is always an object schema and the augmentation asks for an
    // object; a top-level array is not valid structured output (object-only
    // contract, consistent across all parse tiers).
    expect(tryParseStructuredOutput('[1,2,3]')).toBeUndefined();
  });

  test('strips ```json fences', () => {
    const input = '```json\n{"verdict":"ok"}\n```';
    expect(tryParseStructuredOutput(input)).toEqual({ verdict: 'ok' });
  });

  test('strips bare ``` fences', () => {
    const input = '```\n{"verdict":"ok"}\n```';
    expect(tryParseStructuredOutput(input)).toEqual({ verdict: 'ok' });
  });

  test('strips leading and trailing whitespace', () => {
    expect(tryParseStructuredOutput('   \n  {"x":42}  \n  ')).toEqual({ x: 42 });
  });

  test('recovers via forward scan when prose precedes the JSON', () => {
    const input = `Let me think this through...

After careful evaluation, here is the JSON:

{"verdict":"ok","reason":"clean"}`;
    expect(tryParseStructuredOutput(input)).toEqual({ verdict: 'ok', reason: 'clean' });
  });

  test('forward scan handles fence-wrapped JSON with preamble', () => {
    // Fence strip runs first; preamble before the fence remains, then tier 2
    // forward-scans for the first `{` past the leftover prose.
    const input = `Let me think...

\`\`\`json
{"v":"yes"}
\`\`\``;
    expect(tryParseStructuredOutput(input)).toEqual({ v: 'yes' });
  });

  test('returns undefined for empty input', () => {
    expect(tryParseStructuredOutput('')).toBeUndefined();
    expect(tryParseStructuredOutput('   \n  ')).toBeUndefined();
  });

  test('returns undefined for invalid JSON', () => {
    expect(tryParseStructuredOutput('{not valid')).toBeUndefined();
    expect(tryParseStructuredOutput('prose only, no JSON anywhere')).toBeUndefined();
  });

  test('returns undefined for bare primitives that parse cleanly', () => {
    // Schema augmentation always asks for an object; primitives are not
    // "structured output" and must not satisfy the contract.
    expect(tryParseStructuredOutput('null')).toBeUndefined();
    expect(tryParseStructuredOutput('42')).toBeUndefined();
    expect(tryParseStructuredOutput('"plain string"')).toBeUndefined();
    expect(tryParseStructuredOutput('true')).toBeUndefined();
    expect(tryParseStructuredOutput('false')).toBeUndefined();
  });

  test('returns undefined when forward scan finds no parseable JSON', () => {
    // First `{` is at index > 0 but what follows is not valid JSON either.
    expect(tryParseStructuredOutput('prose with stray { brace and no closer')).toBeUndefined();
  });

  // Tier 3: jsonrepair structural recovery (issue #1849 / structured-output plan)
  test('tier 3 repairs trailing commas', () => {
    expect(tryParseStructuredOutput('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  test('tier 3 repairs single-quoted keys and values', () => {
    expect(tryParseStructuredOutput("{'verdict':'ok'}")).toEqual({ verdict: 'ok' });
  });

  test('tier 3 repairs a max_tokens-truncated tail', () => {
    // Response cut mid-object by a token cap — jsonrepair closes the structure.
    expect(tryParseStructuredOutput('{"summary":"done","items":["a","b"')).toEqual({
      summary: 'done',
      items: ['a', 'b'],
    });
  });

  test('tier 3 still returns undefined for irreparable non-JSON', () => {
    expect(tryParseStructuredOutput('this is just prose, not JSON at all')).toBeUndefined();
  });

  test('tier 3 rejects a valid object followed by trailing prose (no bogus array)', () => {
    // jsonrepair would coerce `{...}\nprose` into `[{...}, "prose"]`; the object-only
    // gate rejects that so the result degrades cleanly instead of surfacing an array.
    expect(
      tryParseStructuredOutput('Here is the JSON:\n{"ok":true}\nHope this helps!')
    ).toBeUndefined();
  });
});

describe('normalizeJsonSchemaForOpenAiStrict', () => {
  const conditionalSchema = (operator: 'oneOf' | 'anyOf' | 'allOf') => ({
    type: 'object',
    additionalProperties: false,
    properties: { status: { type: 'string' }, message: { type: 'string' } },
    required: ['status', 'message'],
    [operator]:
      operator === 'allOf'
        ? [{ properties: { status: { enum: ['success', 'blocked'] } } }]
        : ['success', 'blocked'].map(status => ({
            properties: { status: { const: status } },
          })),
  });
  const ajv = new Ajv({ strict: false });

  test.each(['oneOf', 'anyOf', 'allOf'] as const)(
    'preserves parent fields and partial %s constraints',
    operator => {
      const input = conditionalSchema(operator);
      const before = structuredClone(input);
      const normalized = normalizeJsonSchemaForOpenAiStrict(input);
      const original = ajv.compile(input);
      const converted = ajv.compile(normalized);
      for (const [payload, valid] of [
        [{ status: 'success', message: 'Finished' }, true],
        [{ status: 'blocked', message: 'Need access' }, true],
        [{ status: 'success' }, false],
        [{ message: 'Finished' }, false],
        [{ status: 'unknown', message: 'Finished' }, false],
        [{ status: 1, message: 'Finished' }, false],
        [{ status: 'success', message: 1 }, false],
        [{ status: 'success', message: 'Finished', extra: true }, false],
      ] as const) {
        expect(original(payload)).toBe(valid);
        expect(converted(payload)).toBe(valid);
      }
      expect(findStrictSchemaIssues(normalized, 'schema')).toEqual([]);
      expect(input).toEqual(before);
      expect(normalizeJsonSchemaForOpenAiStrict(normalized)).toEqual(normalized);
    }
  );

  for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
    test.each([undefined, true])(
      `refuses ${operator} branch-only required fields with parent openness %j`,
      additionalProperties => {
        const input = {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
          ...(additionalProperties === undefined ? {} : { additionalProperties }),
          [operator]: [{ properties: { detail: { type: 'string' } }, required: ['detail'] }],
        };
        expect(ajv.compile(input)({ status: 'success', detail: 'Finished' })).toBe(true);
        expect(findPreparedStrictSchemaIssues(input)).toEqual([
          expect.objectContaining({
            kind: 'unsupported-conversion',
            message: expect.stringMatching(/detail.*complete property map/),
          }),
        ]);
        const complete = {
          ...input,
          properties: { ...input.properties, detail: { type: 'string' } },
          required: ['status', 'detail'],
        };
        expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
        expect(
          ajv.compile(normalizeJsonSchemaForOpenAiStrict(complete))({
            status: 'success',
            detail: 'Finished',
          })
        ).toBe(true);
      }
    );

    test(`refuses ${operator} branch-only fields under an empty parent map`, () => {
      const input = {
        type: 'object',
        properties: {},
        required: [],
        [operator]: [{ properties: { detail: { type: 'string' } }, required: ['detail'] }],
      };
      expect(ajv.compile(input)({ detail: 'Finished' })).toBe(true);
      expect(findPreparedStrictSchemaIssues(input)).toEqual([
        expect.objectContaining({
          kind: 'unsupported-conversion',
          message: expect.stringContaining('detail'),
        }),
      ]);
    });

    test(`refuses ${operator} nested redeclarations missing parent fields`, () => {
      const input = {
        type: 'object',
        properties: {
          payload: {
            type: 'object',
            properties: { status: { type: 'string' }, message: { type: 'string' } },
            required: ['status', 'message'],
          },
        },
        required: ['payload'],
        [operator]: [{ properties: { payload: { properties: { status: { const: 'success' } } } } }],
      };
      expect(ajv.compile(input)({ payload: { status: 'success', message: 'Finished' } })).toBe(
        true
      );
      expect(findPreparedStrictSchemaIssues(input)).toEqual([
        expect.objectContaining({
          kind: 'unsupported-conversion',
          message: expect.stringMatching(/payload.*message.*complete.*branch/),
        }),
      ]);
      const complete = {
        ...input,
        [operator]: [
          {
            properties: {
              payload: {
                ...input.properties.payload,
                properties: {
                  ...input.properties.payload.properties,
                  status: { const: 'success' },
                },
              },
            },
          },
        ],
      };
      expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
      expect(
        ajv.compile(normalizeJsonSchemaForOpenAiStrict(complete))({
          payload: { status: 'success', message: 'Finished' },
        })
      ).toBe(true);
    });

    test.each(['object', 'array'])(
      `refuses ${operator} incomplete nested maps inside %s properties`,
      wrapper => {
        const complete = {
          type: 'object',
          properties: { status: { type: 'string' }, message: { type: 'string' } },
          required: ['status', 'message'],
        };
        const partial = { properties: { status: { const: 'success' } } };
        const wrap = (schema: Record<string, unknown>) =>
          wrapper === 'array'
            ? { type: 'array', items: schema }
            : { type: 'object', properties: { inner: schema }, required: ['inner'] };
        const input = {
          type: 'object',
          properties: { payload: wrap(complete) },
          required: ['payload'],
          [operator]: [{ properties: { payload: wrap(partial) } }],
        };
        const value = { status: 'success', message: 'Finished' };
        expect(
          ajv.compile(input)({ payload: wrapper === 'array' ? [value] : { inner: value } })
        ).toBe(true);
        expect(findPreparedStrictSchemaIssues(input)).toEqual([
          expect.objectContaining({
            kind: 'unsupported-conversion',
            message: expect.stringContaining('message'),
          }),
        ]);
      }
    );

    test(`refuses ${operator} typed additionalProperties on a partial branch`, () => {
      const input = {
        ...conditionalSchema(operator),
        [operator]: [
          {
            properties: { status: { const: 'success' } },
            required: ['status'],
            additionalProperties: { type: 'string' },
          },
        ],
      };
      expect(ajv.compile(input)({ status: 'success', message: 'Finished' })).toBe(true);
      expect(findPreparedStrictSchemaIssues(input)).toEqual([
        expect.objectContaining({
          kind: 'unsupported-conversion',
          message: expect.stringContaining('complete'),
        }),
      ]);
      const complete = {
        ...input,
        [operator]: [
          {
            properties: { status: { const: 'success' }, message: { type: 'string' } },
            required: ['status', 'message'],
            additionalProperties: { type: 'string' },
          },
        ],
      };
      expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
      expect(
        ajv.compile(normalizeJsonSchemaForOpenAiStrict(complete))({
          status: 'success',
          message: 'Finished',
        })
      ).toBe(true);
    });
  }

  test.each(['default', 'examples', 'x-data'])(
    'preserves %s annotation data without interpreting resource declarations',
    keyword => {
      const data = {
        properties: { payload: { $id: 'payload.json', type: 'string' } },
        anyOf: [{ properties: { status: { const: 'success' } } }],
      };
      const input = {
        ...conditionalSchema('oneOf'),
        [keyword]: keyword === 'examples' ? [data] : data,
      };
      const before = structuredClone(input);
      expect(ajv.compile(input)({ status: 'success', message: 'Finished' })).toBe(true);
      expect(findPreparedStrictSchemaIssues(input)).toEqual([]);
      const normalized = normalizeJsonSchemaForOpenAiStrict(input);
      expect(normalized[keyword]).toEqual(input[keyword]);
      expect(normalized[keyword]).not.toBe(input[keyword]);
      expect(input).toEqual(before);
    }
  );

  test('normalizes schemas for keyword-named properties without closing their map', () => {
    const input = {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          properties: { default: { type: 'string' } },
          required: ['default'],
        },
        default: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      },
      required: ['properties', 'default'],
    };
    expect(findPreparedStrictSchemaIssues(input)).toEqual([]);
    const normalized = normalizeJsonSchemaForOpenAiStrict(input);
    const validate = ajv.compile(normalized);
    expect(validate({ properties: { default: 'ok' }, default: { value: 'ok' } })).toBe(true);
    expect(validate({ properties: { default: 'ok', extra: true }, default: { value: 'ok' } })).toBe(
      false
    );
  });

  for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
    for (const definitions of ['$defs', 'definitions'] as const) {
      test.each(['all-reference', 'mixed-inline'] as const)(
        `rejects ${operator} ${definitions} branches with %s placement`,
        placement => {
          const input = {
            ...conditionalSchema(operator),
            [definitions]: {
              Success: { properties: { status: { const: 'success' } } },
              Blocked: { properties: { status: { const: 'blocked' } } },
              Either: { properties: { status: { enum: ['success', 'blocked'] } } },
            },
            [operator]:
              operator === 'allOf'
                ? [
                    { $ref: `#/${definitions}/Either` },
                    ...(placement === 'mixed-inline' ? [{ properties: { status: {} } }] : []),
                  ]
                : [
                    placement === 'mixed-inline'
                      ? { properties: { status: { const: 'success' } } }
                      : { $ref: `#/${definitions}/Success` },
                    { $ref: `#/${definitions}/Blocked` },
                  ],
          };
          const original = new Ajv({ strict: false }).compile(input);
          expect(original({ status: 'success', message: 'Finished' })).toBe(true);
          expect(original({ status: 'blocked', message: 'Need access' })).toBe(true);
          expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete inline');
        }
      );
    }
  }

  for (const keyword of ['dependencies', 'dependentSchemas'] as const) {
    for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
      test.each(['partial-inline', 'partial-reference', 'complete-inline'] as const)(
        `${keyword}/${operator}/%s retains valid answers or refuses before conversion`,
        shape => {
          const dependency = {
            properties: {
              message: { type: 'string', minLength: 2 },
              ...(shape === 'complete-inline' ? { status: { type: 'string' } } : {}),
            },
            required: ['message'],
          };
          const input = {
            ...conditionalSchema(operator),
            $defs: { Dependency: dependency },
            [operator]: [
              {
                properties: { status: { enum: ['success', 'blocked'] } },
                [keyword]: {
                  status:
                    shape === 'partial-reference' ? { $ref: '#/$defs/Dependency' } : dependency,
                },
              },
            ],
          };
          const compiler = keyword === 'dependencies' ? ajv : new Ajv2020({ strict: false });
          const original = compiler.compile(input);
          expect(original({ status: 'success', message: 'Finished' })).toBe(true);
          expect(original({ status: 'blocked', message: 'Need access' })).toBe(true);
          if (shape !== 'complete-inline') {
            expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete inline');
          } else {
            const converted = compiler.compile(normalizeJsonSchemaForOpenAiStrict(input));
            for (const validate of [original, converted]) {
              expect(validate({ status: 'success', message: 'Finished' })).toBe(true);
              expect(validate({ status: 'blocked', message: 'Need access' })).toBe(true);
              expect(validate({ status: 'success', message: 'x' })).toBe(false);
              expect(validate({ status: 'success' })).toBe(false);
              expect(validate({ status: 'unknown', message: 'Finished' })).toBe(false);
            }
          }
        }
      );
    }
  }

  for (const keyword of ['dependencies', 'dependentSchemas'] as const) {
    test.each(['enclosing', 'nested', 'composition-in-dependency'] as const)(
      `rejects unsafe ${keyword} on %s composition ancestry`,
      placement => {
        const partial = { properties: { status: { type: 'string' } } };
        const dependency = placement === 'nested' ? { [keyword]: { message: partial } } : partial;
        const conditional = conditionalSchema('anyOf');
        const input =
          placement === 'composition-in-dependency'
            ? {
                type: 'object',
                properties: { status: { type: 'string' }, message: { type: 'string' } },
                required: ['status', 'message'],
                [keyword]: { status: { anyOf: [partial] } },
              }
            : { ...conditional, [keyword]: { status: dependency } };
        const compiler = keyword === 'dependencies' ? ajv : new Ajv2020({ strict: false });
        const original = compiler.compile(input);
        expect(original({ status: 'success', message: 'Finished' })).toBe(true);
        expect(original({ status: 'blocked', message: 'Need access' })).toBe(true);
        expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete inline');
      }
    );
  }

  test.each(['oneOf', 'anyOf', 'allOf'] as const)(
    'preserves array-valued property dependencies with %s',
    operator => {
      const input = { ...conditionalSchema(operator), dependencies: { status: ['message'] } };
      const converted = ajv.compile(normalizeJsonSchemaForOpenAiStrict(input));
      expect(converted({ status: 'success', message: 'Finished' })).toBe(true);
      expect(converted({ status: 'blocked', message: 'Need access' })).toBe(true);
      expect(converted({ status: 'success' })).toBe(false);
    }
  );

  test.each([
    { required: ['message'] },
    { patternProperties: { '^message$': { type: 'string' } }, required: ['message'] },
    { type: 'object' },
  ])('rejects allOf siblings without an inline property map: %j', sibling => {
    const input = {
      allOf: [
        { properties: { status: { enum: ['success', 'blocked'] } }, required: ['status'] },
        sibling,
      ],
    };
    const original = ajv.compile(input);
    expect(original({ status: 'success', message: 'Finished' })).toBe(true);
    expect(original({ status: 'blocked', message: 'Need access' })).toBe(true);
    expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete inline');
  });

  for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
    test.each(['$ref', '$dynamicRef', '$recursiveRef'])(
      `rejects unresolved same-instance %s in ${operator}`,
      reference => {
        const input = {
          ...conditionalSchema(operator),
          [operator]: [{ [reference]: '#/external' }],
        };
        expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete inline');
      }
    );
    test.each([
      { required: ['message'] },
      { patternProperties: { '^message$': { type: 'string' } } },
      { type: 'object' },
    ])(`rejects mapless object constraints in ${operator}: %j`, branch => {
      expect(() =>
        normalizeJsonSchemaForOpenAiStrict({
          ...conditionalSchema(operator),
          [operator]: [branch],
        })
      ).toThrow('complete inline');
    });
  }

  test.each(['disjoint', 'complete-then-partial'] as const)(
    'rejects unsafe allOf sibling closure: %s',
    shape => {
      const input = {
        allOf: [
          {
            properties: {
              status: { enum: ['success', 'blocked'] },
              ...(shape === 'complete-then-partial' ? { message: { type: 'string' } } : {}),
            },
            required: shape === 'complete-then-partial' ? ['status', 'message'] : ['status'],
          },
          shape === 'disjoint'
            ? { properties: { message: { type: 'string' } }, required: ['message'] }
            : { properties: { status: { type: 'string' } }, required: ['status'] },
        ],
      };
      const validate = ajv.compile(input);
      expect(validate({ status: 'success', message: 'Finished' })).toBe(true);
      expect(validate({ status: 'blocked', message: 'Need access' })).toBe(true);
      expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete property map');
    }
  );

  test('preserves complete allOf siblings', () => {
    const input = {
      allOf: [
        {
          properties: { status: { enum: ['success', 'blocked'] }, message: { type: 'string' } },
          required: ['status', 'message'],
        },
        { properties: { status: { type: 'string' }, message: { minLength: 2 } } },
      ],
    };
    for (const schema of [input, normalizeJsonSchemaForOpenAiStrict(input)]) {
      const validate = ajv.compile(schema);
      expect(validate({ status: 'success', message: 'Finished' })).toBe(true);
      expect(validate({ status: 'blocked', message: 'Need access' })).toBe(true);
      expect(validate({ status: 'success', message: 'x' })).toBe(false);
    }
  });

  for (const identity of ['$id', '$anchor', '$dynamicAnchor'] as const) {
    test.each(['oneOf', 'anyOf', 'allOf'] as const)(
      `rejects copying ${identity} into %s branches`,
      operator => {
        const input = {
          ...conditionalSchema(operator),
          properties: {
            status: { type: 'string' },
            message: {
              [identity]:
                identity === '$id' ? `https://example.com/${operator}/message` : 'message',
              type: 'string',
            },
          },
        };
        expect(
          new Ajv2020({ strict: false }).compile(input)({ status: 'success', message: 'Finished' })
        ).toBe(true);
        expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow(
          'one definition and use $ref'
        );
      }
    );
  }

  test.each(['$id', '$anchor', '$dynamicAnchor'])('rejects copying nested %s', identity => {
    const input = {
      ...conditionalSchema('oneOf'),
      properties: {
        status: { type: 'string' },
        message: {
          type: 'array',
          items: {
            [identity]: identity === '$id' ? 'https://example.com/item' : 'item',
            type: 'string',
          },
        },
      },
    };
    expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow(
      'output_format.oneOf[0].properties.message.items'
    );
  });

  for (const identity of ['$id', '$anchor', '$dynamicAnchor'] as const) {
    test.each(['oneOf', 'anyOf', 'allOf'] as const)(
      `preserves ${identity} without copying it through %s`,
      operator => {
        const input = {
          ...conditionalSchema(operator),
          $defs: {
            Message: {
              [identity]: identity === '$id' ? `https://example.com/defs/${operator}` : 'message',
              type: 'string',
            },
          },
          properties: { status: { type: 'string' }, message: { $ref: '#/$defs/Message' } },
        };
        const validate = new Ajv2020({ strict: false }).compile(
          normalizeJsonSchemaForOpenAiStrict(input)
        );
        expect(validate({ status: 'success', message: 'Finished' })).toBe(true);
        expect(validate({ status: 'blocked', message: 'Need access' })).toBe(true);
        expect(validate({ status: 'success', message: 1 })).toBe(false);

        const complete = {
          ...conditionalSchema(operator),
          properties: {
            status: { type: 'string' },
            message: {
              [identity]:
                identity === '$id' ? `https://example.com/complete/${operator}` : 'message',
              type: 'string',
            },
          },
          [operator]: [{ properties: { status: { type: 'string' }, message: { type: 'string' } } }],
        };
        expect(
          new Ajv2020({ strict: false }).compile(normalizeJsonSchemaForOpenAiStrict(complete))({
            status: 'success',
            message: 'Finished',
          })
        ).toBe(true);
      }
    );
  }

  for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
    for (const placement of ['direct', 'intermediate'] as const) {
      test.each(['relative', 'absolute', 'unchanged-scope', 'complete-local'] as const)(
        `${operator}/${placement}/%s preserves reference targets or refuses copying`,
        shape => {
          const rootId = `https://example.com/${operator}/${placement}/${shape}/root.json`;
          const reference = shape === 'absolute' ? `${rootId}#/$defs/Message` : '#/$defs/Message';
          const branch = {
            properties: {
              status: { enum: ['success', 'blocked'] },
              ...(shape === 'complete-local' ? { message: { type: 'string' } } : {}),
            },
          };
          const resource = {
            ...(shape === 'unchanged-scope' ? {} : { $id: 'branch.json' }),
            $defs: { Message: { type: 'number' } },
          };
          const input = {
            ...conditionalSchema(operator),
            $id: rootId,
            $defs: { Message: { type: 'string' } },
            properties: { status: { type: 'string' }, message: { $ref: reference } },
            [operator]: [
              placement === 'direct'
                ? { ...resource, ...branch }
                : { ...resource, [operator]: [branch] },
            ],
          };
          const original = new Ajv({ strict: false }).compile(input);
          for (const status of ['success', 'blocked']) {
            expect(original({ status, message: 'Finished' })).toBe(true);
          }
          if (shape === 'relative' || shape === 'complete-local') {
            expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow('complete inline');
          } else {
            const converted = new Ajv({ strict: false }).compile(
              normalizeJsonSchemaForOpenAiStrict(input)
            );
            for (const status of ['success', 'blocked']) {
              expect(converted({ status, message: 'Finished' })).toBe(true);
              expect(converted({ status, message: 1 })).toBe(false);
            }
          }
        }
      );
    }
  }

  test.each(['$ref', '$dynamicRef', '$recursiveRef'])(
    'refuses relocated nested relative %s while allowing reference-free properties',
    reference => {
      const input = {
        ...conditionalSchema('anyOf'),
        properties: {
          status: { type: 'string' },
          message: { type: 'array', items: { [reference]: '#/$defs/Message' } },
        },
        anyOf: [{ $id: 'branch.json', properties: { status: { type: 'string' } } }],
      };
      expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow(
        `output_format.anyOf[0].properties.message`
      );
      expect(() =>
        normalizeJsonSchemaForOpenAiStrict({
          ...input,
          properties: { status: { type: 'string' }, message: { type: 'string' } },
        })
      ).not.toThrow();
    }
  );

  for (const edge of ['additionalItems', 'unevaluatedItems'] as const) {
    test.each(['if', 'then', 'else', 'not'] as const)(
      `refuses conditional %s below ${edge}`,
      keyword => {
        const input = {
          type: 'array',
          ...(edge === 'additionalItems' ? { items: [{}] } : { prefixItems: [{}] }),
          [edge]: {
            [keyword]: { properties: { status: { const: 'blocked' } }, required: ['status'] },
          },
        };
        const compiler = edge === 'additionalItems' ? ajv : new Ajv2020({ strict: false });
        if (keyword === 'not') {
          expect(compiler.compile(input)([{}, { status: 'blocked', extra: 1 }])).toBe(false);
        }
        expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow(
          `output_format.${edge}.${keyword}`
        );
      }
    );
  }

  test('ignores conditional keyword names in property maps and annotation data', () => {
    const input = {
      type: 'object',
      properties: { if: { type: 'string' }, not: { type: 'string' } },
      required: ['if', 'not'],
      default: {
        if: true,
        not: false,
        allOf: [{ properties: { x: {} } }, { properties: { y: {} } }],
      },
    };
    expect(normalizeJsonSchemaForOpenAiStrict(input).default).toEqual(input.default);
  });

  test.each(['if', 'then', 'else', 'not'] as const)(
    'rejects unsupported %s before changing its meaning',
    keyword => {
      const input = {
        type: 'object',
        properties: { status: { type: 'string' }, message: { type: 'string' } },
        required: ['status', 'message'],
        [keyword]: { properties: { status: { const: 'success' } }, required: ['status'] },
      };
      expect(() => normalizeJsonSchemaForOpenAiStrict(input)).toThrow(
        'complete oneOf/anyOf branches'
      );
    }
  );

  test('carries constraints through intermediate compositions and completes copied nested fields', () => {
    const input = {
      type: 'object',
      properties: {
        status: { type: 'string' },
        meta: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
      },
      required: ['status', 'meta'],
      anyOf: [
        {
          allOf: [
            {
              oneOf: [
                { properties: { status: { const: 'success' } }, required: ['status'] },
                { properties: { status: { const: 'blocked' } }, required: ['status'] },
              ],
            },
          ],
        },
      ],
    };
    const converted = ajv.compile(normalizeJsonSchemaForOpenAiStrict(input));
    expect(converted({ status: 'success', meta: { tag: 'ok' } })).toBe(true);
    expect(converted({ status: 'blocked', meta: { tag: 'ok' } })).toBe(true);
    expect(converted({ status: 'success', meta: {} })).toBe(false);
    expect(converted({ status: 'success', meta: { tag: 'ok', extra: true } })).toBe(false);
  });

  test('starts independent contexts for properties, array items and definitions', () => {
    const child = conditionalSchema('oneOf');
    const input = {
      type: 'object',
      properties: {
        outer: { type: 'string' },
        child,
        children: { type: 'array', items: child },
        defined: { $ref: '#/$defs/Child' },
      },
      required: ['outer', 'child', 'children', 'defined'],
      $defs: { Child: child },
      anyOf: [{ properties: { outer: { const: 'parent' } }, required: ['outer'] }],
    };
    const converted = ajv.compile(normalizeJsonSchemaForOpenAiStrict(input));
    const payload = { status: 'success', message: 'Finished' };
    expect(
      converted({ outer: 'parent', child: payload, children: [payload], defined: payload })
    ).toBe(true);
    expect(
      converted({ outer: 'other', child: payload, children: [payload], defined: payload })
    ).toBe(false);
  });

  test.each([undefined, true])(
    'inherits only required fields with additionalProperties %j',
    additionalProperties => {
      const input = {
        type: 'object',
        properties: { status: { type: 'string' }, optional: { type: 'number' } },
        required: ['status'],
        anyOf: [
          {
            properties: { status: { const: 'success' } },
            required: ['status'],
            ...(additionalProperties === undefined ? {} : { additionalProperties }),
          },
        ],
      };
      const converted = ajv.compile(normalizeJsonSchemaForOpenAiStrict(input));
      expect(converted({ status: 'success' })).toBe(true);
      expect(converted({ status: 'success', optional: 3 })).toBe(true);
      expect(converted({ status: 'success', optional: 'wrong' })).toBe(false);
      expect(converted({ optional: 3 })).toBe(false);
    }
  );

  test('preserves authored branch closure', () => {
    const input = {
      ...conditionalSchema('oneOf'),
      oneOf: [
        {
          properties: { status: { const: 'success' } },
          required: ['status'],
          additionalProperties: false,
        },
      ],
    };
    const normalized = normalizeJsonSchemaForOpenAiStrict(input);
    expect(normalized.oneOf).toEqual([
      {
        properties: { status: { const: 'success' } },
        required: ['status'],
        additionalProperties: false,
      },
    ]);
    expect(ajv.compile(normalized)({ status: 'success', message: 'Finished' })).toBe(false);
  });

  test('keeps complete branches, narrower constraints, and oneOf exclusivity', () => {
    const input = {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' }, message: { type: 'string', minLength: 2 } },
      required: ['status', 'message'],
      oneOf: [
        {
          properties: { status: { enum: ['success', 'blocked'] }, message: { pattern: '^F' } },
          required: ['message'],
        },
        { properties: { status: { const: 'blocked' } }, required: ['status'] },
      ],
    };
    const original = ajv.compile(input);
    const converted = ajv.compile(normalizeJsonSchemaForOpenAiStrict(input));
    for (const [payload, valid] of [
      [{ status: 'success', message: 'Finished' }, true],
      [{ status: 'success', message: 'Other' }, false],
      [{ status: 'success', message: 'F' }, false],
      [{ status: 'blocked', message: 'Finished' }, false],
      [{ status: 'blocked', message: 'Need access' }, true],
    ] as const) {
      expect(original(payload)).toBe(valid);
      expect(converted(payload)).toBe(valid);
    }
  });

  test('leaves complete closed composition branches unchanged', () => {
    const input = {
      type: 'object',
      properties: { status: { type: 'string' }, message: { type: 'string' } },
      required: ['status', 'message'],
      additionalProperties: false,
      oneOf: ['success', 'blocked'].map(status => ({
        properties: { status: { const: status }, message: { type: 'string' } },
        required: ['status', 'message'],
        additionalProperties: false,
      })),
    };
    const normalized = normalizeJsonSchemaForOpenAiStrict(input);
    expect(normalized).toEqual(input);
    const converted = ajv.compile(normalized);
    expect(converted({ status: 'success', message: 'Finished' })).toBe(true);
    expect(converted({ status: 'blocked', message: 'Need access' })).toBe(true);
  });

  test('adds additionalProperties:false to a top-level object schema', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
  });

  test('recurses into nested object properties', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { b: { type: 'number' } } },
      },
    }) as { additionalProperties: unknown; properties: { nested: Record<string, unknown> } };
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.nested.additionalProperties).toBe(false);
  });

  test('recurses into array items', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({
      type: 'array',
      items: { type: 'object', properties: { c: { type: 'string' } } },
    }) as { items: Record<string, unknown> };
    expect(out.items.additionalProperties).toBe(false);
  });

  test('recurses into anyOf and $defs composition', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({
      $defs: { Foo: { type: 'object', properties: { x: { type: 'string' } } } },
      anyOf: [{ type: 'object', properties: { y: { type: 'string' } } }],
    }) as {
      $defs: { Foo: Record<string, unknown> };
      anyOf: Record<string, unknown>[];
    };
    expect(out.$defs.Foo.additionalProperties).toBe(false);
    expect(out.anyOf[0].additionalProperties).toBe(false);
  });

  test('treats a schema with properties but no explicit type as an object', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({
      properties: { a: { type: 'string' } },
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
  });

  test('handles a type union that includes object', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({
      type: ['object', 'null'],
      properties: { a: { type: 'string' } },
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
  });

  test('replaces an existing additionalProperties subschema with false (OpenAI strict-mode)', () => {
    const input = {
      type: 'object',
      properties: { key: { type: 'string' } },
      additionalProperties: { type: 'number' },
    };
    const out = normalizeJsonSchemaForOpenAiStrict(input) as Record<string, unknown>;
    // OpenAI strict-mode forbids open/typed additional properties; false is the
    // only accepted value, so the subschema is intentionally replaced.
    expect(out.additionalProperties).toBe(false);
    // Input is not mutated.
    expect(input.additionalProperties).toEqual({ type: 'number' });
  });

  test('leaves non-object schemas untouched', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({ type: 'string' }) as Record<string, unknown>;
    expect(out.additionalProperties).toBeUndefined();
  });

  test('does not mutate the input object (returns a deep clone)', () => {
    const input = { type: 'object', properties: { a: { type: 'string' } } };
    normalizeJsonSchemaForOpenAiStrict(input);
    expect('additionalProperties' in input).toBe(false);
  });

  test('is idempotent — an already-normalized schema is structurally unchanged', () => {
    const alreadyNormalized = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        nested: {
          type: 'object',
          properties: { b: { type: 'number' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    };
    const out = normalizeJsonSchemaForOpenAiStrict(alreadyNormalized);
    expect(out).toEqual(alreadyNormalized);
  });
});

describe('strict closure of overlapping branch properties', () => {
  const ajv = new Ajv({ strict: false });
  for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
    test(`refuses ${operator} required fields absent from every property map`, () => {
      const input = {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
        [operator]: [{ properties: { status: { const: 'success' } }, required: ['detail'] }],
      };
      const answer = { status: 'success', detail: 'Finished' };
      expect(ajv.compile(input)(answer)).toBe(true);
      expect(findPreparedStrictSchemaIssues(input)).toEqual([
        expect.objectContaining({
          kind: 'unsupported-conversion',
          message: expect.stringMatching(/detail.*complete property map/),
        }),
      ]);
      const complete = {
        ...input,
        properties: { ...input.properties, detail: { type: 'string' } },
        required: ['status', 'detail'],
      };
      expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
      expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(complete))(answer)).toBe(true);
    });

    test(`refuses ${operator} nested branch-only fields`, () => {
      const parent = {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
      };
      const local = {
        properties: { ...parent.properties, detail: { type: 'string' } },
        required: ['status', 'detail'],
      };
      const input = {
        type: 'object',
        properties: { payload: parent },
        required: ['payload'],
        [operator]: [{ properties: { payload: local } }],
      };
      const answer = { payload: { status: 'success', detail: 'Finished' } };
      expect(ajv.compile(input)(answer)).toBe(true);
      expect(findPreparedStrictSchemaIssues(input)).toEqual([
        expect.objectContaining({
          kind: 'unsupported-conversion',
          message: expect.stringMatching(/payload.*detail.*enclosing/),
        }),
      ]);
      const complete = { ...input, properties: { payload: local } };
      expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
      expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(complete))(answer)).toBe(true);
    });

    for (const definitions of ['$defs', 'definitions'] as const) {
      test.each(['parent', 'branch', 'both'] as const)(
        `refuses ${operator} intersected nested ${definitions} references in %s`,
        placement => {
          const parent = {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
          };
          const local = {
            properties: { ...parent.properties, detail: { type: 'string' } },
            required: ['status', 'detail'],
          };
          const input = {
            type: 'object',
            [definitions]: { Parent: parent, Branch: local },
            properties: {
              payload: placement === 'branch' ? parent : { $ref: `#/${definitions}/Parent` },
            },
            required: ['payload'],
            [operator]: [
              {
                properties: {
                  payload: placement === 'parent' ? local : { $ref: `#/${definitions}/Branch` },
                },
              },
            ],
          };
          const answer = { payload: { status: 'success', detail: 'Finished' } };
          expect(ajv.compile(input)(answer)).toBe(true);
          expect(findPreparedStrictSchemaIssues(input)).toEqual([
            expect.objectContaining({
              kind: 'unsupported-conversion',
              message: expect.stringMatching(/payload.*reference.*inline/),
            }),
          ]);
          const complete = {
            ...input,
            properties: { payload: local },
            [operator]: [{ properties: { payload: local } }],
          };
          expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
          expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(complete))(answer)).toBe(true);
        }
      );
    }
  }
});

describe('nested reference closure refusals', () => {
  for (const reference of ['$dynamicRef', '$recursiveRef'] as const) {
    test.each(['parent', 'branch'] as const)(
      `refuses intersected ${reference} on the %s property`,
      placement => {
        const inline = { properties: { value: { type: 'string' } }, required: ['value'] };
        const ref = { [reference]: '#/$defs/Payload' };
        const input = {
          type: 'object',
          $defs: { Payload: inline },
          properties: { payload: placement === 'parent' ? ref : inline },
          required: ['payload'],
          anyOf: [{ properties: { payload: placement === 'branch' ? ref : inline } }],
        };
        expect(findPreparedStrictSchemaIssues(input)).toEqual([
          expect.objectContaining({
            kind: 'unsupported-conversion',
            message: expect.stringMatching(/payload.*reference.*inline/),
          }),
        ]);
      }
    );
  }
});

describe('strict dependency closure without composition', () => {
  const ajv = new Ajv({ strict: false });
  for (const keyword of ['dependencies', 'dependentSchemas'] as const) {
    test.each(['inline', 'reference'] as const)(
      `refuses partial ${keyword} without composition (%s)`,
      shape => {
        const partial = { properties: { status: { type: 'string' } }, required: ['status'] };
        const input = {
          type: 'object',
          properties: { status: { type: 'string' }, message: { type: 'string' } },
          required: ['status', 'message'],
          $defs: { Dependency: partial },
          [keyword]: { status: shape === 'inline' ? partial : { $ref: '#/$defs/Dependency' } },
        };
        const compiler = keyword === 'dependencies' ? ajv : new Ajv2020({ strict: false });
        const answer = { status: 'success', message: 'Finished' };
        expect(compiler.compile(input)(answer)).toBe(true);
        expect(findPreparedStrictSchemaIssues(input)).toEqual([
          expect.objectContaining({
            kind: 'unsupported-conversion',
            message: expect.stringContaining('complete inline'),
          }),
        ]);
        const complete = {
          ...input,
          [keyword]: { status: { properties: input.properties, required: input.required } },
        };
        expect(findPreparedStrictSchemaIssues(complete)).toEqual([]);
        expect(compiler.compile(normalizeJsonSchemaForOpenAiStrict(complete))(answer)).toBe(true);
      }
    );
  }

  test('preserves property dependencies without composition', () => {
    const input = {
      type: 'object',
      properties: { status: { type: 'string' }, message: { type: 'string' } },
      required: ['status', 'message'],
      dependencies: { status: ['message'] },
    };
    expect(findPreparedStrictSchemaIssues(input)).toEqual([]);
    expect(normalizeJsonSchemaForOpenAiStrict(input).dependencies).toEqual(input.dependencies);
  });
});

describe('hasOpenAdditionalProperties', () => {
  test.each(['default', 'examples', 'x-data'])('ignores open objects in %s data', keyword => {
    const data = { type: 'object', additionalProperties: true };
    const input = {
      type: 'object',
      properties: {},
      [keyword]: keyword === 'examples' ? [data] : data,
    };
    expect(normalizeJsonSchemaForOpenAiStrict(input)[keyword]).toEqual(input[keyword]);
    expect(hasOpenAdditionalProperties(input)).toBe(false);
  });

  test('ignores a schema-shaped property map but detects the actual property schema', () => {
    expect(
      hasOpenAdditionalProperties({
        properties: {
          properties: { type: 'string' },
          additionalProperties: { type: 'boolean' },
        },
        required: ['properties', 'additionalProperties'],
      })
    ).toBe(false);
    expect(
      hasOpenAdditionalProperties({
        properties: { properties: { type: 'object', additionalProperties: true } },
      })
    ).toBe(true);
  });

  test('true when an object declares an open-record additionalProperties subschema', () => {
    expect(
      hasOpenAdditionalProperties({
        type: 'object',
        properties: { key: { type: 'string' } },
        additionalProperties: { type: 'number' },
      })
    ).toBe(true);
  });

  test('true when additionalProperties is the boolean true', () => {
    expect(hasOpenAdditionalProperties({ type: 'object', additionalProperties: true })).toBe(true);
  });

  test('detects an open-record subschema nested below a closed parent', () => {
    expect(
      hasOpenAdditionalProperties({
        type: 'object',
        additionalProperties: false,
        properties: {
          map: { type: 'object', additionalProperties: { type: 'string' } },
        },
      })
    ).toBe(true);
  });

  test('false when every object is already closed (additionalProperties:false)', () => {
    expect(
      hasOpenAdditionalProperties({
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      })
    ).toBe(false);
  });

  test('false when no additionalProperties is declared anywhere', () => {
    expect(
      hasOpenAdditionalProperties({
        type: 'object',
        properties: { a: { type: 'string' } },
      })
    ).toBe(false);
  });

  test('does not flag a non-object node carrying additionalProperties (normalizer leaves it untouched)', () => {
    // No `type: object` and no `properties` → not an object node by the
    // normalizer's rule, so the normalizer would NOT rewrite it. The predicate
    // must match that and stay silent.
    expect(hasOpenAdditionalProperties({ additionalProperties: { type: 'string' } })).toBe(false);
  });
});

describe('nested intersections across same-instance edges', () => {
  const ajv = new Ajv2020({ strict: false });
  const placements = [
    'inline',
    'oneOf',
    'anyOf',
    'allOf',
    'dependencies',
    'dependentSchemas',
  ] as const;
  type Placement = (typeof placements)[number];
  const wrap = (placement: Placement, schema: Record<string, unknown>): Record<string, unknown> => {
    if (placement === 'inline') return schema;
    if (placement === 'dependencies' || placement === 'dependentSchemas') {
      return { [placement]: { inner: schema } };
    }
    return { [placement]: [schema] };
  };
  const base = { properties: { value: { type: 'string' } }, required: ['value'] };
  const complete = {
    properties: { ...base.properties, detail: { type: 'string' } },
    required: ['value', 'detail'],
  };
  const core = (inner: Record<string, unknown>) => ({ properties: { inner }, required: ['inner'] });
  const cases = placements.flatMap(parent =>
    placements.flatMap(local =>
      parent === 'inline' && local === 'inline' ? [] : [{ parent, local }]
    )
  );
  for (const operator of ['oneOf', 'anyOf', 'allOf'] as const) {
    for (const shape of ['extra', 'missing', 'reference'] as const) {
      test.each(cases)(
        `${operator} refuses ${shape} nested intersection at %j`,
        ({ parent, local }) => {
          const parentInner = shape === 'missing' ? complete : base;
          const localInner =
            shape === 'reference'
              ? { $ref: '#/$defs/Complete' }
              : shape === 'missing'
                ? base
                : complete;
          const input = {
            $defs: { Complete: complete },
            properties: { payload: wrap(parent, core(parentInner)) },
            required: ['payload'],
            [operator]: [{ properties: { payload: wrap(local, core(localInner)) } }],
          };
          const answer = { payload: { inner: { value: 'ok', detail: 'Finished' } } };
          expect(ajv.compile(input)(answer)).toBe(true);
          expect(findPreparedStrictSchemaIssues(input)).toEqual([
            expect.objectContaining({
              kind: 'unsupported-conversion',
              message: expect.stringMatching(/payload.*inner.*(complete|inline)/),
            }),
          ]);
          const supported = {
            ...input,
            properties: { payload: wrap(parent, core(complete)) },
            [operator]: [{ properties: { payload: wrap(local, core(complete)) } }],
          };
          expect(findPreparedStrictSchemaIssues(supported)).toEqual([]);
          expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(supported))(answer)).toBe(true);
        }
      );
    }
  }
});

describe('dependency intersections preserve enclosing closure', () => {
  const base = { properties: { value: { type: 'string' } }, required: ['value'] };
  const complete = {
    properties: { ...base.properties, detail: { type: 'string' } },
    required: ['value', 'detail'],
  };
  const cases = [
    { shape: 'dependency-only field', parent: base, dependency: complete },
    {
      shape: 'undeclared required field',
      parent: base,
      dependency: { ...base, required: complete.required },
    },
    {
      shape: 'nested extra',
      parent: { properties: { value: base }, required: ['value'] },
      dependency: { properties: { value: complete }, required: ['value'] },
    },
    {
      shape: 'nested missing',
      parent: { properties: { value: complete }, required: ['value'] },
      dependency: { properties: { value: base }, required: ['value'] },
    },
    {
      shape: 'nested reference',
      parent: { properties: { value: base }, required: ['value'] },
      dependency: { properties: { value: { $ref: '#/$defs/Complete' } }, required: ['value'] },
    },
  ];
  for (const keyword of ['dependencies', 'dependentSchemas'] as const) {
    const ajv =
      keyword === 'dependencies' ? new Ajv({ strict: false }) : new Ajv2020({ strict: false });
    test.each(cases)(`${keyword} refuses $shape`, ({ shape, parent, dependency }) => {
      const input = { ...parent, $defs: { Complete: complete }, [keyword]: { value: dependency } };
      const answer = shape.startsWith('nested')
        ? { value: { value: 'ok', detail: 'Finished' } }
        : { value: 'ok', detail: 'Finished' };
      expect(ajv.compile(input)(answer)).toBe(true);
      expect(findPreparedStrictSchemaIssues(input)).toEqual([
        expect.objectContaining({
          kind: 'unsupported-conversion',
          message: expect.stringMatching(/output_format.*(complete|inline)/),
        }),
      ]);
      const supportedMap = shape.startsWith('nested')
        ? { properties: { value: complete }, required: ['value'] }
        : complete;
      const supported = { ...input, ...supportedMap, [keyword]: { value: supportedMap } };
      expect(findPreparedStrictSchemaIssues(supported)).toEqual([]);
      expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(supported))(answer)).toBe(true);
    });
  }
});

test('refuses an enclosing required name absent from a partial branch completed map', () => {
  const input = {
    properties: { status: { type: 'string' } },
    required: ['status', 'detail'],
    anyOf: [{ properties: { status: { const: 'success' } } }],
  };
  expect(new Ajv({ strict: false }).compile(input)({ status: 'success', detail: 'Finished' })).toBe(
    true
  );
  expect(findPreparedStrictSchemaIssues(input)).toEqual([
    expect.objectContaining({
      kind: 'unsupported-conversion',
      message: expect.stringMatching(
        /output_format.anyOf\[0\].required.*detail.*complete property map/
      ),
    }),
  ]);
});

describe('overlapping array selectors in conditional intersections', () => {
  const base = { properties: { value: { type: 'string' } }, required: ['value'] };
  const complete = {
    properties: { ...base.properties, detail: { type: 'string' } },
    required: ['value', 'detail'],
  };
  const selectors = {
    draft7: {
      items: (item: object) => ({ items: item }),
      first: (item: object) => ({ items: [item] }),
      second: (item: object) => ({ items: [{}, item] }),
      contains: (item: object) => ({ contains: item }),
      additionalItems: (item: object) => ({ items: [{}], additionalItems: item }),
    },
    modern: {
      items: (item: object) => ({ items: item }),
      first: (item: object) => ({ prefixItems: [item] }),
      second: (item: object) => ({ prefixItems: [{}, item] }),
      contains: (item: object) => ({ contains: item }),
      unevaluatedItems: (item: object) => ({ unevaluatedItems: item }),
    },
  };
  for (const dialect of ['draft7', 'modern'] as const) {
    const ajv = dialect === 'draft7' ? new Ajv({ strict: false }) : new Ajv2020({ strict: false });
    const disjoint = new Set([
      'first/second',
      'second/first',
      'first/additionalItems',
      'additionalItems/first',
    ]);
    const cases = Object.entries(selectors[dialect]).flatMap(([parentName, parent]) =>
      Object.entries(selectors[dialect])
        .filter(([localName]) => !disjoint.has(`${parentName}/${localName}`))
        .map(([localName, local]) => ({ parentName, parent, localName, local }))
    );
    for (const operator of [
      'oneOf',
      'anyOf',
      'allOf',
      'dependencies',
      ...(dialect === 'modern' ? ['dependentSchemas'] : []),
    ]) {
      test.each(cases)(
        `${dialect}/${operator}/$parentName/$localName checks item closure`,
        ({ parent, local }) => {
          const schema = (left: object, right: object) => ({
            properties: { payload: { type: 'array', ...parent(left) } },
            required: ['payload'],
            ...(operator === 'dependencies' || operator === 'dependentSchemas'
              ? {
                  [operator]: {
                    payload: {
                      properties: { payload: { type: 'array', ...local(right) } },
                      required: ['payload'],
                    },
                  },
                }
              : {
                  [operator]: [{ properties: { payload: { type: 'array', ...local(right) } } }],
                }),
          });
          const answer = {
            payload: [
              { value: 'ok', detail: 'done' },
              { value: 'ok', detail: 'done' },
            ],
          };
          const input = schema(base, complete);
          expect(ajv.compile(input)(answer)).toBe(true);
          expect(findPreparedStrictSchemaIssues(input)).toEqual([
            expect.objectContaining({
              kind: 'unsupported-conversion',
              message: expect.stringMatching(/payload.*(complete|inline)/),
            }),
          ]);
          const supported = schema(complete, complete);
          expect(findPreparedStrictSchemaIssues(supported)).toEqual([]);
          expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(supported))(answer)).toBe(true);
        }
      );
    }
  }
});

for (const dialect of ['draft7', 'modern'] as const) {
  test(`${dialect} preserves distinct complete positional and trailing item maps`, () => {
    const first = { properties: { value: { type: 'string' } }, required: ['value'] };
    const second = { properties: { detail: { type: 'string' } }, required: ['detail'] };
    const payload =
      dialect === 'draft7'
        ? { type: 'array', items: [first], additionalItems: second }
        : { type: 'array', prefixItems: [first], items: second };
    const input = {
      properties: { payload },
      required: ['payload'],
      anyOf: [{ properties: { payload } }],
    };
    const answer = { payload: [{ value: 'ok' }, { detail: 'done' }] };
    const ajv = dialect === 'draft7' ? new Ajv({ strict: false }) : new Ajv2020({ strict: false });
    expect(ajv.compile(input)(answer)).toBe(true);
    expect(findPreparedStrictSchemaIssues(input)).toEqual([]);
    expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(input))(answer)).toBe(true);
  });
}

describe('nested dependency required fields across same-instance edges', () => {
  const placements = [
    'inline',
    'oneOf',
    'anyOf',
    'allOf',
    'dependencies',
    'dependentSchemas',
  ] as const;
  const wrap = (placement: (typeof placements)[number], inner: object) => {
    if (placement === 'inline') return inner;
    if (placement === 'dependencies' || placement === 'dependentSchemas')
      return { [placement]: { value: inner } };
    return { [placement]: [inner] };
  };
  const complete = {
    properties: { value: { type: 'string' }, detail: { type: 'string' } },
    required: ['value', 'detail'],
  };
  const incomplete = { properties: { value: { type: 'string' } }, required: ['value', 'detail'] };
  for (const edge of ['oneOf', 'anyOf', 'allOf', 'dependencies', 'dependentSchemas'] as const) {
    for (const parent of placements) {
      for (const local of placements) {
        for (const missing of ['parent', 'local', 'both'] as const) {
          test(`${edge}/${parent}/${local}/${missing} refuses nested undeclared requirements`, () => {
            const schema = (left: object, right: object) => {
              const parentSchema = {
                properties: { value: wrap(parent, left) },
                required: ['value'],
              };
              const localSchema = {
                properties: { value: wrap(local, right) },
                required: ['value'],
              };
              return {
                ...parentSchema,
                ...(edge === 'dependencies' || edge === 'dependentSchemas'
                  ? { [edge]: { value: localSchema } }
                  : { [edge]: [localSchema] }),
              };
            };
            const declared = { properties: incomplete.properties, required: ['value'] };
            const input = schema(
              missing === 'local' ? declared : incomplete,
              missing === 'parent' ? declared : incomplete
            );
            const answer = { value: { value: 'ok', detail: 'done' } };
            const ajv = new Ajv2019({ strict: false });
            expect(ajv.compile(input)(answer)).toBe(true);
            expect(findPreparedStrictSchemaIssues(input)).toEqual([
              expect.objectContaining({
                kind: 'unsupported-conversion',
                message: expect.stringMatching(/value.*(complete|inline)/),
              }),
            ]);
            const supported = schema(complete, complete);
            expect(findPreparedStrictSchemaIssues(supported)).toEqual([]);
            expect(ajv.compile(normalizeJsonSchemaForOpenAiStrict(supported))(answer)).toBe(true);
          });
        }
      }
    }
  }
});

describe('unused definitions do not constrain enclosing instances', () => {
  for (const definitions of ['$defs', 'definitions'] as const) {
    for (const outer of ['oneOf', 'anyOf', 'allOf'] as const) {
      for (const inner of ['oneOf', 'anyOf', 'allOf'] as const) {
        test(`${definitions}/${outer}/${inner} keeps independent declarations`, () => {
          const object = { properties: { value: { type: 'string' } }, required: ['value'] };
          const input = {
            properties: { payload: { ...object, [definitions]: { Unused: object } } },
            required: ['payload'],
            [outer]: [
              {
                properties: {
                  payload: {
                    [inner]: [
                      {
                        ...object,
                        [definitions]: {
                          Unused: {
                            properties: { detail: { type: 'string' } },
                            required: ['detail'],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          };
          const ajv = new Ajv2020({ strict: false });
          expect(findPreparedStrictSchemaIssues(input)).toEqual([]);
          const prepared = normalizeJsonSchemaForOpenAiStrict(input);
          expect(ajv.compile(input)({ payload: { value: 'ok' } })).toBe(true);
          expect(ajv.compile(prepared)({ payload: { value: 'ok' } })).toBe(true);
          expect(prepared.properties).toMatchObject({
            payload: { [definitions]: { Unused: { additionalProperties: false } } },
          });
        });
      }
    }
  }
});
