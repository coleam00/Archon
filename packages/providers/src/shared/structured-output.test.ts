import { describe, expect, test } from 'bun:test';

import {
  augmentPromptForJsonSchema,
  normalizeJsonSchemaForOpenAiStrict,
  tryParseStructuredOutput,
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

  test('returns the parsed array for clean JSON', () => {
    expect(tryParseStructuredOutput('[1,2,3]')).toEqual([1, 2, 3]);
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

  test('leaves non-object schemas untouched', () => {
    const out = normalizeJsonSchemaForOpenAiStrict({ type: 'string' }) as Record<string, unknown>;
    expect(out.additionalProperties).toBeUndefined();
  });

  test('does not mutate the input object (returns a deep clone)', () => {
    const input = { type: 'object', properties: { a: { type: 'string' } } };
    normalizeJsonSchemaForOpenAiStrict(input);
    expect('additionalProperties' in input).toBe(false);
  });
});
