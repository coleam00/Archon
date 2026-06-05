import { describe, it, expect, mock } from 'bun:test';

// --- Mock logger (MUST come before imports of modules under test) ---

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// --- Imports (after mocks) ---

import { evaluateCondition } from './condition-evaluator';
import { OutputRefError } from './output-ref';
import type { NodeOutput } from './schemas';

/**
 * Build a NodeOutput fixture for condition tests.
 * Omits `structuredOutput` when undefined so the field's `'structuredOutput' in nodeOutput`
 * presence check in resolveOutputRef matches real producer behavior (only Pi/Codex/Claude
 * paths populate it; older providers leave it off). `declaredFields` marks a
 * declared-schema producer (output_format with properties) for strict-resolution tests.
 */
function makeOutput(
  output: string,
  state: 'completed' | 'failed' | 'skipped' = 'completed',
  structuredOutput?: unknown,
  declaredFields?: string[]
): NodeOutput {
  if (state === 'failed')
    return {
      state,
      output,
      error: 'error',
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(declaredFields !== undefined ? { declaredFields } : {}),
    };
  if (state === 'skipped') return { state, output };
  return {
    state,
    output,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(declaredFields !== undefined ? { declaredFields } : {}),
  };
}

describe('evaluateCondition', () => {
  it('== operator: returns true when output matches', () => {
    const outputs = new Map([['classify', makeOutput('BUG')]]);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(true);
  });

  it('== operator: returns false when output does not match', () => {
    const outputs = new Map([['classify', makeOutput('FEATURE')]]);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(false);
  });

  it('!= operator: returns true when output differs', () => {
    const outputs = new Map([['classify', makeOutput('FEATURE')]]);
    expect(evaluateCondition("$classify.output != 'BUG'", outputs).result).toBe(true);
  });

  it('!= operator: returns false when output equals the value', () => {
    const outputs = new Map([['classify', makeOutput('BUG')]]);
    expect(evaluateCondition("$classify.output != 'BUG'", outputs).result).toBe(false);
  });

  it('dot notation: accesses JSON field for output_format nodes', () => {
    const jsonOutput = JSON.stringify({ type: 'BUG', confidence: 0.9 });
    const outputs = new Map([['classify', makeOutput(jsonOutput)]]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output.type == 'FEATURE'", outputs).result).toBe(false);
  });

  it('dot notation: returns JSON stringified value for array fields', () => {
    const jsonOutput = JSON.stringify({ items: ['todo', 'fix'], count: 2 });
    const outputs = new Map([['gather', makeOutput(jsonOutput)]]);

    const expectedItems = JSON.stringify(['todo', 'fix']);
    const condition = "$gather.output.items == '" + expectedItems + "'";
    expect(evaluateCondition(condition, outputs).result).toBe(true);
  });

  it('dot notation: returns JSON stringified value for object fields', () => {
    const jsonOutput = JSON.stringify({ config: { timeout: 30 } });
    const outputs = new Map([['setup', makeOutput(jsonOutput)]]);
    const expectedConfig = JSON.stringify({ timeout: 30 });
    const condition = "$setup.output.config == '" + expectedConfig + "'";
    expect(evaluateCondition(condition, outputs).result).toBe(true);
  });
  it('dot notation: throws on a field ref when schemaless output is not JSON (no-silent-drop)', () => {
    const outputs = new Map([['classify', makeOutput('not-json')]]);
    // A `.field` ref on a schemaless node whose output is not a JSON object is a
    // drop the author must see — it fails the node, not silently resolves to ''.
    expect(() => evaluateCondition("$classify.output.type == 'BUG'", outputs)).toThrow(
      OutputRefError
    );
  });

  it('unknown node: treats missing node output as empty string and warns', () => {
    mockLogFn.mockClear();
    const outputs = new Map<string, NodeOutput>();
    expect(evaluateCondition("$missing.output == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$missing.output == 'BUG'", outputs).result).toBe(false);
    const warnCalls = mockLogFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'condition_output_ref_unknown_node'
    );
    expect(warnCalls.length).toBe(2);
    expect(warnCalls[0][0]).toEqual(expect.objectContaining({ nodeId: 'missing' }));
  });

  it('failed node: output is empty string, conditions evaluate accordingly', () => {
    const outputs = new Map([['classify', makeOutput('', 'failed')]]);
    expect(evaluateCondition("$classify.output == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(false);
  });

  it('invalid expression: defaults to false (fail-closed) with parsed: false', () => {
    const outputs = new Map<string, NodeOutput>();
    const res = evaluateCondition('not a valid condition', outputs);
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  it('valid expression returns parsed: true', () => {
    const outputs = new Map([['n', makeOutput('FOO')]]);
    const res = evaluateCondition("$n.output == 'FOO'", outputs);
    expect(res.parsed).toBe(true);
  });

  it('supports spaces around operator', () => {
    const outputs = new Map([['n', makeOutput('FOO')]]);
    expect(evaluateCondition("$n.output=='FOO'", outputs).result).toBe(true);
    expect(evaluateCondition("$n.output == 'FOO'", outputs).result).toBe(true);
  });

  it('empty expected value: matches empty output', () => {
    const outputs = new Map([['n', makeOutput('')]]);
    expect(evaluateCondition("$n.output == ''", outputs).result).toBe(true);
  });

  it('dot notation != operator: returns true when JSON field differs', () => {
    const jsonOutput = JSON.stringify({ type: 'FEATURE' });
    const outputs = new Map([['classify', makeOutput(jsonOutput)]]);
    expect(evaluateCondition("$classify.output.type != 'BUG'", outputs).result).toBe(true);
  });

  it('dot notation: coerces number field to string', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ confidence: 0.9 }))]]);
    expect(evaluateCondition("$n.output.confidence == '0.9'", outputs).result).toBe(true);
  });

  it('dot notation: coerces boolean field to string', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ valid: true }))]]);
    expect(evaluateCondition("$n.output.valid == 'true'", outputs).result).toBe(true);
  });

  it('dot notation: works with clean structured output (simulates output_format fix)', () => {
    // After the fix, output_format nodes store clean JSON (from SDK structured_output)
    // instead of mixed prose+JSON
    const cleanJson = JSON.stringify({ run_code_review: 'true', run_tests: 'false' });
    const outputs = new Map([['classify', makeOutput(cleanJson)]]);
    expect(evaluateCondition("$classify.output.run_code_review == 'true'", outputs).result).toBe(
      true
    );
    expect(evaluateCondition("$classify.output.run_tests == 'true'", outputs).result).toBe(false);
    expect(evaluateCondition("$classify.output.run_tests == 'false'", outputs).result).toBe(true);
  });

  // --- Numeric comparison operators ---

  it('> operator: returns true when actual is numerically greater', () => {
    expect(evaluateCondition("$n.output > '5'", new Map([['n', makeOutput('10')]]))).toEqual({
      result: true,
      parsed: true,
    });
    expect(evaluateCondition("$n.output > '5'", new Map([['n', makeOutput('5')]])).result).toBe(
      false
    );
    expect(evaluateCondition("$n.output > '5'", new Map([['n', makeOutput('3')]])).result).toBe(
      false
    );
  });

  it('>= operator: returns true when actual is greater than or equal', () => {
    expect(evaluateCondition("$n.output >= '5'", new Map([['n', makeOutput('5')]])).result).toBe(
      true
    );
    expect(evaluateCondition("$n.output >= '5'", new Map([['n', makeOutput('6')]])).result).toBe(
      true
    );
    expect(evaluateCondition("$n.output >= '5'", new Map([['n', makeOutput('4')]])).result).toBe(
      false
    );
  });

  it('< operator: returns true when actual is numerically less', () => {
    expect(evaluateCondition("$n.output < '5'", new Map([['n', makeOutput('3')]])).result).toBe(
      true
    );
    expect(evaluateCondition("$n.output < '5'", new Map([['n', makeOutput('5')]])).result).toBe(
      false
    );
  });

  it('<= operator: returns true when actual is less than or equal', () => {
    expect(evaluateCondition("$n.output <= '5'", new Map([['n', makeOutput('5')]])).result).toBe(
      true
    );
    expect(evaluateCondition("$n.output <= '5'", new Map([['n', makeOutput('4')]])).result).toBe(
      true
    );
    expect(evaluateCondition("$n.output <= '5'", new Map([['n', makeOutput('6')]])).result).toBe(
      false
    );
  });

  it('numeric operators: work with floating point values', () => {
    expect(
      evaluateCondition("$n.output >= '0.9'", new Map([['n', makeOutput('0.95')]])).result
    ).toBe(true);
    expect(
      evaluateCondition("$n.output >= '0.9'", new Map([['n', makeOutput('0.85')]])).result
    ).toBe(false);
  });

  it('numeric operators: work with dot-notation JSON fields', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ score: 0.95 }))]]);
    expect(evaluateCondition("$n.output.score >= '0.9'", outputs).result).toBe(true);
  });

  it('numeric operator: fail-closed when actual is not numeric', () => {
    const res = evaluateCondition("$n.output > '5'", new Map([['n', makeOutput('hello')]]));
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  it('numeric operator: fail-closed when expected is not numeric', () => {
    const res = evaluateCondition("$n.output > 'abc'", new Map([['n', makeOutput('10')]]));
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  // --- AND compound expressions ---

  it('&& operator: true when both conditions are true', () => {
    const outputs = new Map([
      ['a', makeOutput('X')],
      ['b', makeOutput('Y')],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).result).toBe(true);
  });

  it('&& operator: false when first condition is false', () => {
    const outputs = new Map([
      ['a', makeOutput('Z')],
      ['b', makeOutput('Y')],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).result).toBe(false);
  });

  it('&& operator: false when second condition is false', () => {
    const outputs = new Map([
      ['a', makeOutput('X')],
      ['b', makeOutput('Z')],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).result).toBe(false);
  });

  it('&& operator: parsed: true for valid compound expression', () => {
    const outputs = new Map([
      ['a', makeOutput('X')],
      ['b', makeOutput('Y')],
    ]);
    expect(evaluateCondition("$a.output == 'X' && $b.output == 'Y'", outputs).parsed).toBe(true);
  });

  // --- OR compound expressions ---

  it('|| operator: true when first condition is true', () => {
    const outputs = new Map([
      ['a', makeOutput('X')],
      ['b', makeOutput('Z')],
    ]);
    expect(evaluateCondition("$a.output == 'X' || $b.output == 'Y'", outputs).result).toBe(true);
  });

  it('|| operator: true when second condition is true', () => {
    const outputs = new Map([
      ['a', makeOutput('Z')],
      ['b', makeOutput('Y')],
    ]);
    expect(evaluateCondition("$a.output == 'X' || $b.output == 'Y'", outputs).result).toBe(true);
  });

  it('|| operator: false when both conditions are false', () => {
    const outputs = new Map([
      ['a', makeOutput('Z')],
      ['b', makeOutput('W')],
    ]);
    expect(evaluateCondition("$a.output == 'X' || $b.output == 'Y'", outputs).result).toBe(false);
  });

  // --- Operator precedence: && binds tighter than || ---

  it('&& has higher precedence than ||: (A && B) || C', () => {
    // A=false, B=true, C=true → (false && true) || true = true
    const outputs = new Map([
      ['a', makeOutput('Z')],
      ['b', makeOutput('Y')],
      ['c', makeOutput('V')],
    ]);
    expect(
      evaluateCondition("$a.output == 'X' && $b.output == 'Y' || $c.output == 'V'", outputs).result
    ).toBe(true);
    // A=true, B=false, C=false → (true && false) || false = false
    const outputs2 = new Map([
      ['a', makeOutput('X')],
      ['b', makeOutput('Z')],
      ['c', makeOutput('W')],
    ]);
    expect(
      evaluateCondition("$a.output == 'X' && $b.output == 'Y' || $c.output == 'V'", outputs2).result
    ).toBe(false);
  });

  // --- Compound with numeric operators ---

  it('compound with numeric operator', () => {
    const outputs = new Map([
      ['score', makeOutput('90')],
      ['flag', makeOutput('true')],
    ]);
    expect(
      evaluateCondition("$score.output > '80' && $flag.output == 'true'", outputs).result
    ).toBe(true);
    expect(
      evaluateCondition("$score.output > '80' && $flag.output == 'false'", outputs).result
    ).toBe(false);
  });

  // --- Compound fail-closed ---

  it('compound: fail-closed when any atom is invalid', () => {
    const outputs = new Map([
      ['a', makeOutput('X')],
      ['b', makeOutput('Y')],
    ]);
    const res = evaluateCondition("$a.output == 'X' && not-valid", outputs);
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  it('|| operator: short-circuits on true first clause — invalid second clause is not evaluated', () => {
    // When the first OR clause is true, the second clause (even if invalid) is not reached.
    // This is intentional short-circuit OR behavior. A typo in a later OR clause will still
    // surface as a parse error on runs where the earlier clauses are false.
    const outputs = new Map([['a', makeOutput('X')]]);
    const res = evaluateCondition("$a.output == 'X' || not-valid", outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(true); // short-circuit: invalid second clause never reached
  });

  // --- splitOutsideQuotes guard: operators inside quoted values are not treated as splitters ---

  it('splitOutsideQuotes guard: value containing && is not split on the operator', () => {
    const outputs = new Map([['n', makeOutput('A&&B')]]);
    const res = evaluateCondition("$n.output == 'A&&B'", outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(true);
  });

  it('splitOutsideQuotes guard: value containing || is not split on the operator', () => {
    const outputs = new Map([['n', makeOutput('A||B')]]);
    const res = evaluateCondition("$n.output == 'A||B'", outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(true);
  });

  // --- structuredOutput preference (Pi/Minimax fence-wrapped JSON, Codex/Claude output_format) ---

  it('structuredOutput: prefers structuredOutput.field over JSON.parse(output)', () => {
    // Pi-shape: prose output with structuredOutput populated by tryParseStructuredOutput.
    // If we fell back to JSON.parse(output) we would read 'WRONG'; structuredOutput says 'BUG'.
    const outputs = new Map([
      [
        'classify',
        makeOutput('Here is the classification: {"type":"WRONG"}', 'completed', {
          type: 'BUG',
          confidence: 0.9,
        }),
      ],
    ]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output.type == 'WRONG'", outputs).result).toBe(false);
  });

  it('structuredOutput: falls back to JSON.parse(output) when structuredOutput is absent', () => {
    // Claude/Codex backward-compat: no structuredOutput on the NodeOutput, JSON in `output`.
    const outputs = new Map([['classify', makeOutput(JSON.stringify({ type: 'BUG' }))]]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(true);
  });

  it('structuredOutput: coerces numeric field to string', () => {
    const outputs = new Map([['score', makeOutput('', 'completed', { confidence: 0.95 })]]);
    expect(evaluateCondition("$score.output.confidence == '0.95'", outputs).result).toBe(true);
    expect(evaluateCondition("$score.output.confidence >= '0.9'", outputs).result).toBe(true);
  });

  it('structuredOutput: coerces boolean field to string', () => {
    const outputs = new Map([['n', makeOutput('', 'completed', { valid: true })]]);
    expect(evaluateCondition("$n.output.valid == 'true'", outputs).result).toBe(true);
  });

  it('structuredOutput: JSON-stringifies object/array fields', () => {
    const outputs = new Map([
      ['n', makeOutput('', 'completed', { items: ['a', 'b'], nested: { x: 1 } })],
    ]);
    const expectedItems = JSON.stringify(['a', 'b']);
    expect(evaluateCondition("$n.output.items == '" + expectedItems + "'", outputs).result).toBe(
      true
    );
    const expectedNested = JSON.stringify({ x: 1 });
    expect(evaluateCondition("$n.output.nested == '" + expectedNested + "'", outputs).result).toBe(
      true
    );
  });

  it('structuredOutput: null field value JSON-stringifies to "null"', () => {
    // Matches existing JSON.parse-path behavior: typeof null === 'object' so null → "null".
    const outputs = new Map([['n', makeOutput('', 'completed', { type: null })]]);
    expect(evaluateCondition("$n.output.type == 'null'", outputs).result).toBe(true);
  });

  it('structuredOutput: works with empty output text (Pi-only-structured case)', () => {
    // structuredOutput populated, output text empty — dot-access should still work.
    const outputs = new Map([['classify', makeOutput('', 'completed', { type: 'BUG' })]]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(true);
  });

  it('structuredOutput: null at top level falls through to JSON.parse fallback', () => {
    // structuredOutput === null is not an object → must skip the preference branch and use output.
    const outputs = new Map([
      ['n', makeOutput(JSON.stringify({ type: 'BUG' }), 'completed', null)],
    ]);
    expect(evaluateCondition("$n.output.type == 'BUG'", outputs).result).toBe(true);
  });

  it('structuredOutput: top-level array falls through to JSON.parse fallback', () => {
    // structuredOutput is array → ambiguous semantics for `.field` access, fall through.
    const outputs = new Map([
      ['n', makeOutput(JSON.stringify({ type: 'BUG' }), 'completed', [1, 2, 3])],
    ]);
    expect(evaluateCondition("$n.output.type == 'BUG'", outputs).result).toBe(true);
  });

  it('structuredOutput: primitive at top level falls through to JSON.parse fallback', () => {
    const outputs = new Map([
      ['n', makeOutput(JSON.stringify({ type: 'BUG' }), 'completed', 'just-a-string')],
    ]);
    expect(evaluateCondition("$n.output.type == 'BUG'", outputs).result).toBe(true);
  });

  it('structuredOutput: missing field resolves to empty string (no JSON.parse retry)', () => {
    // When structuredOutput is a usable object but the field is missing, we do NOT retry
    // JSON.parse(output) — the structuredOutput is authoritative.
    const outputs = new Map([
      [
        'classify',
        makeOutput(JSON.stringify({ type: 'BUG' }), 'completed', {
          /* no `type` key */ confidence: 0.9,
        }),
      ],
    ]);
    expect(evaluateCondition("$classify.output.type == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(false);
  });

  it('structuredOutput: unfielded $node.output reference still uses output text', () => {
    // The preference applies to dot-notation only. Bare `$n.output` falls back to output text.
    const outputs = new Map([['n', makeOutput('prose text', 'completed', { type: 'BUG' })]]);
    expect(evaluateCondition("$n.output == 'prose text'", outputs).result).toBe(true);
  });

  // --- #1673: condition_json_parse_failed must surface as parsed:false ---

  it('throws (not silent skip) when output text is not valid JSON and a field is used', () => {
    const outputs = new Map([
      ['gate', makeOutput('Let me think...\n\nSure, here is my analysis.')],
    ]);
    // #1673 previously fail-closed-skipped this; the no-silent-drop contract makes
    // an unresolvable `.field` ref a visible node failure instead of a silent skip.
    expect(() => evaluateCondition("$gate.output.verdict == 'review'", outputs)).toThrow(
      OutputRefError
    );
  });

  it('strips markdown fences and parses JSON inside them', () => {
    const fenced = 'Let me analyze...\n\n```json\n{"verdict": "review"}\n```\n';
    const outputs = new Map([['gate', makeOutput(fenced)]]);
    expect(evaluateCondition("$gate.output.verdict == 'review'", outputs).result).toBe(true);
    expect(evaluateCondition("$gate.output.verdict == 'review'", outputs).parsed).toBe(true);
  });

  it('strips plain ``` fences (no language tag) and parses JSON', () => {
    const fenced = '```\n{"verdict": "approve"}\n```';
    const outputs = new Map([['gate', makeOutput(fenced)]]);
    expect(evaluateCondition("$gate.output.verdict == 'approve'", outputs).result).toBe(true);
  });

  it('throws when a compound expression references a field on non-JSON output', () => {
    const outputs = new Map([
      ['a', makeOutput('{"ok": "yes"}')],
      ['b', makeOutput('not json at all')],
    ]);
    // `$a.output.ok` resolves fine; `$b.output.status` (b is non-JSON) throws,
    // which propagates out of the compound evaluation to fail the node.
    expect(() =>
      evaluateCondition("$a.output.ok == 'yes' && $b.output.status == 'done'", outputs)
    ).toThrow(OutputRefError);
  });

  // --- shorthand path ($nodeId.field) ---

  it('shorthand path: $node.field is equivalent to $node.output.field', () => {
    const outputs = new Map([['classify', makeOutput(JSON.stringify({ type: 'BUG' }))]]);
    expect(evaluateCondition("$classify.type == 'BUG'", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.type == 'FEATURE'", outputs).result).toBe(false);
  });

  it('shorthand path: matches the canonical .output.field form exactly', () => {
    const outputs = new Map([['classify', makeOutput(JSON.stringify({ type: 'BUG' }))]]);
    expect(evaluateCondition("$classify.type == 'BUG'", outputs)).toEqual(
      evaluateCondition("$classify.output.type == 'BUG'", outputs)
    );
  });

  it('shorthand path: resolves structuredOutput like the canonical form', () => {
    const outputs = new Map([['classify', makeOutput('prose', 'completed', { type: 'BUG' })]]);
    expect(evaluateCondition("$classify.type == 'BUG'", outputs).result).toBe(true);
  });

  it('shorthand path: works with numeric operators', () => {
    const outputs = new Map([['score', makeOutput(JSON.stringify({ confidence: 0.95 }))]]);
    expect(evaluateCondition("$score.confidence >= '0.9'", outputs).result).toBe(true);
    expect(evaluateCondition("$score.confidence >= '0.99'", outputs).result).toBe(false);
  });

  it('shorthand path: rejects a sub-field ($node.field.subfield) fail-closed', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ a: { b: 'x' } }))]]);
    const res = evaluateCondition("$n.a.b == 'x'", outputs);
    expect(res.result).toBe(false);
    expect(res.parsed).toBe(false);
  });

  it('shorthand path: throws on a missing key in a schemaless JSON node (no-silent-drop)', () => {
    // Valid JSON output but no `missing` key, and no declared schema → the author
    // referenced a key that isn't there. Strict for schemaless producers: throw
    // rather than silently resolve to '' (matches the canonical `.output.field` form).
    const outputs = new Map([['n', makeOutput(JSON.stringify({ type: 'BUG' }))]]);
    expect(() => evaluateCondition("$n.missing == 'x'", outputs)).toThrow(OutputRefError);
  });

  it('declared-optional field absent resolves to empty string (no throw)', () => {
    // A producer that DECLARED the field in its output_format schema but left it
    // absent (optional) is the one case that stays '' — not a drop, an intended gap.
    const outputs = new Map([
      [
        'classify',
        makeOutput(JSON.stringify({ type: 'BUG' }), 'completed', { type: 'BUG' }, ['type', 'note']),
      ],
    ]);
    expect(evaluateCondition("$classify.output.note == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output.note == 'x'", outputs).result).toBe(false);
  });

  it('field not in the declared schema throws (typo, not a silent skip)', () => {
    const outputs = new Map([
      [
        'classify',
        makeOutput(JSON.stringify({ type: 'BUG' }), 'completed', { type: 'BUG' }, ['type']),
      ],
    ]);
    expect(() => evaluateCondition("$classify.output.tpye == 'BUG'", outputs)).toThrow(
      OutputRefError
    );
  });

  // --- unquoted numeric/boolean RHS ---

  it('unquoted RHS: integer comparison with ==', () => {
    const outputs = new Map([['t', makeOutput(JSON.stringify({ exit_code: 0 }))]]);
    expect(evaluateCondition('$t.exit_code == 0', outputs).result).toBe(true);
    expect(evaluateCondition('$t.exit_code == 1', outputs).result).toBe(false);
  });

  it('unquoted RHS: negative integer comparison', () => {
    const outputs = new Map([['t', makeOutput(JSON.stringify({ delta: -3 }))]]);
    expect(evaluateCondition('$t.delta == -3', outputs).result).toBe(true);
  });

  it('unquoted RHS: integer with numeric operators', () => {
    const outputs = new Map([['t', makeOutput(JSON.stringify({ exit_code: 0 }))]]);
    expect(evaluateCondition('$t.exit_code > 0', outputs).result).toBe(false);
    expect(evaluateCondition('$t.exit_code >= 0', outputs).result).toBe(true);
    expect(evaluateCondition('$t.exit_code < 1', outputs).result).toBe(true);
  });

  it('unquoted RHS: decimal comparison', () => {
    const outputs = new Map([['score', makeOutput(JSON.stringify({ confidence: 0.95 }))]]);
    expect(evaluateCondition('$score.confidence >= 0.9', outputs).result).toBe(true);
    expect(evaluateCondition('$score.confidence == 0.95', outputs).result).toBe(true);
  });

  it('unquoted RHS: boolean true/false', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ passed: true }))]]);
    expect(evaluateCondition('$n.passed == true', outputs).result).toBe(true);
    expect(evaluateCondition('$n.passed == false', outputs).result).toBe(false);
    expect(evaluateCondition('$n.passed != false', outputs).result).toBe(true);
  });

  it('unquoted RHS: works on the canonical .output.field form too', () => {
    const outputs = new Map([['t', makeOutput(JSON.stringify({ exit_code: 0 }))]]);
    expect(evaluateCondition('$t.output.exit_code == 0', outputs).result).toBe(true);
  });

  it('unquoted RHS: parsed:true for a valid unquoted expression', () => {
    const outputs = new Map([['t', makeOutput(JSON.stringify({ exit_code: 0 }))]]);
    expect(evaluateCondition('$t.exit_code == 0', outputs).parsed).toBe(true);
  });

  it('mixed quoted + unquoted inside an AND compound', () => {
    const outputs = new Map([
      ['classify', makeOutput(JSON.stringify({ type: 'BUG' }))],
      ['test', makeOutput(JSON.stringify({ exit_code: 0 }))],
    ]);
    expect(
      evaluateCondition("$classify.type == 'BUG' && $test.exit_code == 0", outputs).result
    ).toBe(true);
    expect(
      evaluateCondition("$classify.type == 'BUG' && $test.exit_code == 1", outputs).result
    ).toBe(false);
  });

  it('mixed quoted + unquoted inside an OR compound', () => {
    const outputs = new Map([
      ['classify', makeOutput(JSON.stringify({ type: 'FEATURE' }))],
      ['test', makeOutput(JSON.stringify({ passed: true }))],
    ]);
    expect(
      evaluateCondition("$classify.type == 'BUG' || $test.passed == true", outputs).result
    ).toBe(true);
    expect(
      evaluateCondition("$classify.type == 'BUG' || $test.passed == false", outputs).result
    ).toBe(false);
  });
});
