import { describe, expect, test } from 'bun:test';

import { augmentPromptForJsonSchema, tryParseStructuredOutput } from './structured-output';

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
