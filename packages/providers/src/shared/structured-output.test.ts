import { describe, expect, test } from 'bun:test';

import {
  augmentPromptForJsonSchema,
  formatSchemaErrors,
  hasOpenAdditionalProperties,
  normalizeJsonSchemaForOpenAiStrict,
  tryParseStructuredOutput,
  validateStructuredOutput,
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

  test('optional field absent is still valid (additionalProperties not required)', () => {
    expect(validateStructuredOutput({ summary: 'hi' }, schema).valid).toBe(true);
  });

  test('uncompilable schema fails SAFE (valid:true) and reports via onCompileError', () => {
    let compileError: string | undefined;
    // `$ref` to a non-existent definition makes ajv.compile throw.
    const broken = { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } };
    const r = validateStructuredOutput({ a: 1 }, broken, msg => {
      compileError = msg;
    });
    expect(r.valid).toBe(true);
    expect(compileError).toBeDefined();
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

describe('normalizeJsonSchemaForOpenAiStrict', () => {
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

describe('hasOpenAdditionalProperties', () => {
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
