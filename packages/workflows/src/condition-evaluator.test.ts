import { describe, it, expect, mock } from 'bun:test';

// --- Mock logger (MUST come before imports of modules under test) ---

const mockLogFn = mock((_data: unknown, _message?: string): void => {});
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

import { evaluateCondition, InputRefError } from './condition-evaluator';
import { OutputRefError } from './output-ref';
import { parseWhenAtom, whenAtoms } from './when-atom';
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

  it('dot notation: rejects array fields and logs safe diagnostic metadata', () => {
    mockLogFn.mockClear();
    const jsonOutput = JSON.stringify({ items: ['todo', 'fix'], count: 2 });
    const outputs = new Map([['gather', makeOutput(jsonOutput)]]);

    expect(() => evaluateCondition("$gather.output.items == 'true'", outputs)).toThrow(
      "Condition reference '$gather.output.items' resolved to an array"
    );
    expect(mockLogFn).toHaveBeenCalledWith(
      {
        nodeId: 'gather',
        field: 'items',
        actualType: 'array',
        exprSnippet: "$gather.output.items == 'true'",
      },
      'dag.condition_field_not_primitive'
    );
  });

  it('dot notation: rejects object fields', () => {
    const jsonOutput = JSON.stringify({ config: { timeout: 30 } });
    const outputs = new Map([['setup', makeOutput(jsonOutput)]]);
    expect(() => evaluateCondition("$setup.output.config == 'true'", outputs)).toThrow(
      "Condition reference '$setup.output.config' resolved to an object"
    );
  });

  it('rejects structured fields from the previous loop iteration', () => {
    mockLogFn.mockClear();
    const priorOutputs = new Map([
      ['work', makeOutput(JSON.stringify({ route: { ready: true } }))],
    ]);

    expect(() =>
      evaluateCondition("$LOOP_PREV.work.output.route == 'true'", new Map(), undefined, {
        loopPrevOutputs: priorOutputs,
      })
    ).toThrow("Condition reference '$work.output.route' resolved to an object");
    expect(mockLogFn).toHaveBeenCalledWith(
      {
        nodeId: 'work',
        field: 'route',
        actualType: 'object',
        exprSnippet: "$LOOP_PREV.work.output.route == 'true'",
      },
      'dag.condition_field_not_primitive'
    );
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

  it('unknown node WITH a field: throws (no-silent-drop, unknown-node)', () => {
    // Whole-text `$missing.output` stays lenient (test above), but a `.field` ref to
    // an unknown id is a typo — it must fail the node, matching the strict field
    // posture and `substituteNodeOutputRefs`. did-you-mean names the near miss.
    const outputs = new Map([['classify', makeOutput('BUG')]]);
    let caught: unknown;
    try {
      evaluateCondition("$classfy.output.type == 'BUG'", outputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutputRefError);
    expect((caught as OutputRefError).reason).toBe('unknown-node');
    expect((caught as OutputRefError).message).toContain("'classify'");
  });

  it('failed producer (#2713): whole-text $node.output throws instead of evaluating stale output', () => {
    // Mirrors a loop_group's failure paths: the stored output is real, non-empty text
    // (lastIterationOutput), not '' — the premise the old version of this test assumed.
    // A when: condition joined past the failure via trigger_rule: all_done must not
    // silently evaluate that stale text as if the producer had succeeded.
    const outputs = new Map([['corrections', makeOutput('CORRECTIONS_APPLIED', 'failed')]]);
    expect(() =>
      evaluateCondition("$corrections.output == 'CORRECTIONS_APPLIED'", outputs)
    ).toThrow();
    // Even an empty-output failed producer throws — state gates this, not content.
    const emptyFailed = new Map([['classify', makeOutput('', 'failed')]]);
    expect(() => evaluateCondition("$classify.output == ''", emptyFailed)).toThrow();
  });

  it('failed producer (#2713): fielded $node.output.field throws even on valid JSON leftover output', () => {
    // The issue's own reproduction: a failed loop_group whose leftover output happens
    // to be valid JSON must not resolve a field from it as if the group had succeeded.
    const outputs = new Map([
      ['corrections', makeOutput(JSON.stringify({ ready: true }), 'failed')],
    ]);
    let caught: unknown;
    try {
      evaluateCondition('$corrections.output.ready == true', outputs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutputRefError);
    expect((caught as OutputRefError).reason).toBe('producer-failed');
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

  it('structuredOutput: rejects object/array fields', () => {
    const outputs = new Map([
      ['n', makeOutput('', 'completed', { items: ['a', 'b'], nested: { x: 1 } })],
    ]);
    expect(() => evaluateCondition("$n.output.items == 'true'", outputs)).toThrow(
      "Condition reference '$n.output.items' resolved to an array"
    );
    expect(() => evaluateCondition("$n.output.nested == 'true'", outputs)).toThrow(
      "Condition reference '$n.output.nested' resolved to an object"
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

// ---------------------------------------------------------------------------
// Shared when-atom parser (#2566) — the grammar the loader validates against and
// the evaluator runs. Tested here rather than in a new file so it stays in the
// same `bun test` invocation as its primary consumer.
// ---------------------------------------------------------------------------

describe('parseWhenAtom', () => {
  it('parses a whole-output ref (no field)', () => {
    expect(parseWhenAtom("$check.output == 'ok'")).toEqual({
      ref: { kind: 'node', nodeId: 'check', field: undefined },
      operator: '==',
      expected: 'ok',
    });
  });

  it('parses a canonical field ref', () => {
    expect(parseWhenAtom("$classify.output.type == 'BUG'")).toEqual({
      ref: { kind: 'node', nodeId: 'classify', field: 'type' },
      operator: '==',
      expected: 'BUG',
    });
  });

  it('parses the $node.field shorthand as a field ref', () => {
    expect(parseWhenAtom("$classify.type != 'BUG'")).toEqual({
      ref: { kind: 'node', nodeId: 'classify', field: 'type' },
      operator: '!=',
      expected: 'BUG',
    });
  });

  it('parses an unquoted numeric RHS under every operator', () => {
    for (const op of ['==', '!=', '<=', '>=', '<', '>'] as const) {
      expect(parseWhenAtom(`$t.output.score ${op} 80`)).toEqual({
        ref: { kind: 'node', nodeId: 't', field: 'score' },
        operator: op,
        expected: '80',
      });
    }
  });

  it('parses $INPUTS.<name> as an input ref, not a node called INPUTS', () => {
    expect(parseWhenAtom("$INPUTS.mode == 'fast'")).toEqual({
      ref: { kind: 'input', name: 'mode' },
      operator: '==',
      expected: 'fast',
    });
  });

  it('parses a hyphenated input name (the with:/inputs: grammar allows hyphens)', () => {
    expect(parseWhenAtom("$INPUTS.base-branch == 'dev'")).toEqual({
      ref: { kind: 'input', name: 'base-branch' },
      operator: '==',
      expected: 'dev',
    });
  });

  it('treats $INPUTS.output as the input NAMED output, not a whole-output ref', () => {
    expect(parseWhenAtom("$INPUTS.output == 'x'")).toEqual({
      ref: { kind: 'input', name: 'output' },
      operator: '==',
      expected: 'x',
    });
  });

  it('rejects a sub-field on an input ref (INPUTS is reserved, not a node id)', () => {
    expect(parseWhenAtom("$INPUTS.a.b == 'x'")).toBeNull();
  });

  it('rejects a sub-field on the shorthand form', () => {
    expect(parseWhenAtom("$classify.type.sub == 'x'")).toBeNull();
  });

  it('rejects malformed atoms', () => {
    expect(parseWhenAtom("$classify.output = 'BUG'")).toBeNull();
    expect(parseWhenAtom('not an atom')).toBeNull();
    expect(parseWhenAtom('$classify.output ==')).toBeNull();
  });
});

describe('whenAtoms', () => {
  it('flattens && and || into individual atoms', () => {
    expect(whenAtoms("$a.output == 'X' && $b.output != 'Y' || $c.output == 'Z'")).toEqual([
      "$a.output == 'X'",
      "$b.output != 'Y'",
      "$c.output == 'Z'",
    ]);
  });

  it('does not split on separators inside a quoted literal', () => {
    expect(whenAtoms("$a.output == 'x && y'")).toEqual(["$a.output == 'x && y'"]);
  });
});

// ---------------------------------------------------------------------------
// $INPUTS in when: (#2453 defect 1) — a sub-run child can BRANCH on a caller's
// `with:` value, not just read it in a prompt.
// ---------------------------------------------------------------------------

describe('evaluateCondition — $INPUTS refs', () => {
  const noOutputs = new Map<string, NodeOutput>();

  it('branches on a supplied input value', () => {
    const inputs = { mode: 'fast' };
    expect(evaluateCondition("$INPUTS.mode == 'fast'", noOutputs, inputs).result).toBe(true);
    expect(evaluateCondition("$INPUTS.mode == 'slow'", noOutputs, inputs).result).toBe(false);
    expect(evaluateCondition("$INPUTS.mode != 'slow'", noOutputs, inputs).parsed).toBe(true);
  });

  it('supports numeric comparison on an input value', () => {
    expect(evaluateCondition("$INPUTS.limit > '5'", noOutputs, { limit: '10' }).result).toBe(true);
  });

  it('combines with node-output refs in a compound expression', () => {
    const outputs = new Map([['gate', makeOutput(JSON.stringify({ verdict: 'go' }))]]);
    expect(
      evaluateCondition("$INPUTS.mode == 'fast' && $gate.output.verdict == 'go'", outputs, {
        mode: 'fast',
      }).result
    ).toBe(true);
  });

  it('resolves an input literally named "output" instead of coincidentally returning empty', () => {
    // Before #2453 defect 1 was fixed, `$INPUTS.output` parsed as node `INPUTS` with no
    // field and resolved to '' — a condition that quietly compared nothing.
    expect(evaluateCondition("$INPUTS.output == 'v'", noOutputs, { output: 'v' }).result).toBe(
      true
    );
  });

  it('THROWS on an undeclared input rather than resolving to empty', () => {
    expect(() => evaluateCondition("$INPUTS.mode == ''", noOutputs, { other: 'x' })).toThrow(
      InputRefError
    );
    expect(() => evaluateCondition("$INPUTS.mode == 'fast'", noOutputs, { other: 'x' })).toThrow(
      /Available inputs: \$INPUTS\.other\./
    );
  });

  it('THROWS when the run carries no inputs at all', () => {
    expect(() => evaluateCondition("$INPUTS.mode == 'fast'", noOutputs)).toThrow(
      /This run has no declared inputs\./
    );
  });

  it('offers a did-you-mean hint for a near-miss input name', () => {
    expect(() => evaluateCondition("$INPUTS.mdoe == 'fast'", noOutputs, { mode: 'fast' })).toThrow(
      /Did you mean \$INPUTS\.mode\?/
    );
  });
});

// #2637 — inputs are JSON-valued: a typed input compares as its canonical text,
// so the existing unquoted-RHS grammar works on real booleans and numbers.
describe('typed $INPUTS values in when: (#2637)', () => {
  const noOutputs = new Map<string, NodeOutput>();

  it('a boolean input matches an unquoted boolean literal', () => {
    expect(evaluateCondition('$INPUTS.flag == true', noOutputs, { flag: true })).toEqual({
      result: true,
      parsed: true,
    });
    expect(evaluateCondition('$INPUTS.flag == true', noOutputs, { flag: false })).toEqual({
      result: false,
      parsed: true,
    });
  });

  it('a numeric input compares numerically', () => {
    expect(evaluateCondition('$INPUTS.count > 2', noOutputs, { count: 3 })).toEqual({
      result: true,
      parsed: true,
    });
  });

  it('a null input compares as its canonical text "null", never as empty', () => {
    expect(evaluateCondition("$INPUTS.v == 'null'", noOutputs, { v: null })).toEqual({
      result: true,
      parsed: true,
    });
  });
});

// #2999 — structured $INPUTS values (objects/arrays) in when: expressions must fail loudly
// with diagnostic metadata rather than silently stringify-comparing.
describe('structured $INPUTS values in when: (#2999)', () => {
  const noOutputs = new Map<string, NodeOutput>();

  it('rejects object-valued inputs, failing false-skips loudly with safe diagnostic log', () => {
    mockLogFn.mockClear();
    expect(() =>
      evaluateCondition("$INPUTS.route == 'true'", noOutputs, { route: { ready: true } })
    ).toThrow(
      "Condition reference '$INPUTS.route' resolved to an object. " +
        "A 'when:' input must be a string, number, boolean, or null; emit a scalar routing field " +
        'or inspect structured data in a script node.'
    );
    expect(mockLogFn).toHaveBeenCalledWith(
      {
        input: 'route',
        actualType: 'object',
        exprSnippet: "$INPUTS.route == 'true'",
      },
      'dag.condition_field_not_primitive'
    );
  });

  it('rejects array-valued inputs, failing false-skips loudly with safe diagnostic log', () => {
    mockLogFn.mockClear();
    expect(() =>
      evaluateCondition("$INPUTS.items == 'true'", noOutputs, { items: ['a', 'b'] })
    ).toThrow(
      "Condition reference '$INPUTS.items' resolved to an array. " +
        "A 'when:' input must be a string, number, boolean, or null; emit a scalar routing field " +
        'or inspect structured data in a script node.'
    );
    expect(mockLogFn).toHaveBeenCalledWith(
      {
        input: 'items',
        actualType: 'array',
        exprSnippet: "$INPUTS.items == 'true'",
      },
      'dag.condition_field_not_primitive'
    );
  });

  it('rejects stringify-coincidence comparisons against hand-typed JSON literals', () => {
    mockLogFn.mockClear();
    expect(() =>
      evaluateCondition('$INPUTS.tags == \'["a","b"]\'', noOutputs, { tags: ['a', 'b'] })
    ).toThrow("Condition reference '$INPUTS.tags' resolved to an array");

    expect(() =>
      evaluateCondition('$INPUTS.config == \'{"timeout":30}\'', noOutputs, {
        config: { timeout: 30 },
      })
    ).toThrow("Condition reference '$INPUTS.config' resolved to an object");
  });
});
