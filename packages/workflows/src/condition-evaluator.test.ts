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
import type { NodeOutput } from './schemas';

function makeOutput(
  output: string,
  state: 'completed' | 'failed' | 'skipped' = 'completed'
): NodeOutput {
  if (state === 'failed') return { state, output, error: 'error' };
  return { state, output };
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

  it('dot notation: returns false on invalid JSON (fails gracefully)', () => {
    const outputs = new Map([['classify', makeOutput('not-json')]]);
    // Should not throw; JSON parse fails, resolves to '', so == 'BUG' is false
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(false);
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
});
