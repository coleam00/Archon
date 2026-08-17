import { describe, test, expect } from 'bun:test';
import { parse, format, toDnf } from './when-grammar';

describe('when-grammar parse', () => {
  test('parses a bare output atom', () => {
    const r = parse("$classify.output == 'BUG'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or).toEqual([[{ kind: 'node', nodeId: 'classify', op: '==', value: 'BUG' }]]);
    }
  });

  test('parses a field atom', () => {
    const r = parse("$classify.output.type != 'FEATURE'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or[0][0]).toEqual({
        kind: 'node',
        nodeId: 'classify',
        field: 'type',
        op: '!=',
        value: 'FEATURE',
      });
    }
  });

  test('parses a HYPHENATED node id', () => {
    // Every other fixture here is hyphen-free, so this is the only case that
    // catches the node-id slot being filled with the hyphen-free segment
    // grammar — the natural slip now that ATOM_PATTERN is composed rather than
    // written out. `archon-validate-pr.yaml` ships exactly this condition, so
    // the slip would reject a bundled workflow that runs fine in production.
    const r = parse("$classify-testability.output.testable == 'e2e_testable'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or[0][0]).toEqual({
        kind: 'node',
        nodeId: 'classify-testability',
        field: 'testable',
        op: '==',
        value: 'e2e_testable',
      });
    }
  });

  test('parses all six operators', () => {
    for (const op of ['==', '!=', '<', '>', '<=', '>='] as const) {
      const r = parse(`$n.output ${op} '5'`);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.ast.or[0][0].op).toBe(op);
    }
  });

  test('parses && (inner) and || (outer) into DNF', () => {
    const r = parse("$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or.length).toBe(2);
      expect(r.ast.or[0].length).toBe(2);
      expect(r.ast.or[1].length).toBe(1);
    }
  });

  test('does not split on operators inside quoted values', () => {
    const r = parse("$a.output == 'x && y || z'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or.length).toBe(1);
      expect(r.ast.or[0][0].value).toBe('x && y || z');
    }
  });

  test('parses the $node.field shorthand (engine parity)', () => {
    const r = parse('$build.exit_code == 0');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or).toEqual([
        [
          {
            kind: 'node',
            nodeId: 'build',
            field: 'exit_code',
            op: '==',
            value: '0',
            shorthand: true,
            bare: true,
          },
        ],
      ]);
    }
  });

  test('parses bare boolean and numeric RHS (engine parity)', () => {
    const bool = parse('$check.passed == true');
    expect(bool.ok).toBe(true);
    if (bool.ok) {
      expect(bool.ast.or[0][0]).toEqual({
        kind: 'node',
        nodeId: 'check',
        field: 'passed',
        op: '==',
        value: 'true',
        shorthand: true,
        bare: true,
      });
    }
    const num = parse('$score.output.value >= -0.5');
    expect(num.ok).toBe(true);
    if (num.ok) {
      expect(num.ast.or[0][0]).toEqual({
        kind: 'node',
        nodeId: 'score',
        field: 'value',
        op: '>=',
        value: '-0.5',
        bare: true,
      });
    }
  });

  test('rejects a sub-field on the shorthand path (engine parity)', () => {
    const r = parse("$a.field.sub == 'x'");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sub-field');
  });

  test('errors on malformed input', () => {
    expect(parse('').ok).toBe(false);
    expect(parse('garbage').ok).toBe(false);
    expect(parse('$a.output ~~ 5').ok).toBe(false);
    expect(parse('$a.output == unquoted').ok).toBe(false);
    // Bare RHS only covers numbers and booleans, not identifiers.
    expect(parse('$a.output == yes').ok).toBe(false);
  });
});

// `$INPUTS.<name>` is the engine's input scope (#2470), and the builder rejected
// every one of these conditions until #2591 — a workflow using a declared input in
// a `when:` validated clean at load and red in the builder.
describe('when-grammar parse — $INPUTS (engine parity)', () => {
  test('parses an input atom', () => {
    const r = parse("$INPUTS.mode == 'fast'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or).toEqual([[{ kind: 'input', name: 'mode', op: '==', value: 'fast' }]]);
    }
  });

  test('an input name may be hyphenated', () => {
    // Input names use the engine's `with:` key grammar, which admits hyphens.
    const r = parse("$INPUTS.my-input == 'x'");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.ast.or[0][0]).toEqual({ kind: 'input', name: 'my-input', op: '==', value: 'x' });
  });

  test('binds to the input scope even when the name is `output`', () => {
    // The input branch is tried first, so this is the input named `output`,
    // not a node called INPUTS.
    const r = parse("$INPUTS.output == 'x'");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.ast.or[0][0]).toEqual({ kind: 'input', name: 'output', op: '==', value: 'x' });
  });

  test('takes a bare RHS like any other atom', () => {
    const r = parse('$INPUTS.retries >= 3');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or[0][0]).toEqual({
        kind: 'input',
        name: 'retries',
        op: '>=',
        value: '3',
        bare: true,
      });
    }
  });

  test('rejects a sub-field on an input ref', () => {
    // The regex backtracks into the node branch with nodeId `INPUTS`; the engine's
    // parseWhenAtom returns null there and so must the builder.
    const r = parse("$INPUTS.a.b == 'x'");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cannot carry a sub-field');
  });

  test('rejects a bare $INPUTS with no name', () => {
    expect(parse("$INPUTS == 'x'").ok).toBe(false);
  });

  test('composes with node atoms in one expression', () => {
    const r = parse("$INPUTS.mode == 'fast' && $classify.output.type == 'BUG'");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast.or[0].length).toBe(2);
  });
});

describe('when-grammar format', () => {
  test('round-trips parse → format', () => {
    const inputs = [
      "$classify.output == 'BUG'",
      "$classify.output.type != 'FEATURE'",
      "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'",
      // Shorthand paths and bare RHS keep their original spelling.
      '$build.exit_code == 0',
      '$check.passed == true',
      "$score.output.value >= -0.5 && $gate.approved == 'yes'",
      // A quoted numeral stays quoted (it is not rewritten to bare).
      "$n.output == '-1'",
      // Input refs round-trip in both RHS spellings, alone and mixed with nodes.
      "$INPUTS.mode == 'fast'",
      '$INPUTS.retries >= 3',
      "$INPUTS.mode == 'fast' && $classify.output.type == 'BUG'",
    ];
    for (const input of inputs) {
      const r = parse(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(format(r.ast)).toBe(input);
    }
  });

  test('quotes a non-numeric value even if a hand-built atom claims bare', () => {
    expect(
      format({ or: [[{ kind: 'node', nodeId: 'a', op: '==', value: 'hello', bare: true }]] })
    ).toBe("$a.output == 'hello'");
  });

  test('an empty AST formats to undefined (no when condition)', () => {
    expect(format({ or: [] })).toBeUndefined();
    expect(format({ or: [[], []] })).toBeUndefined();
  });

  test('empty AND-groups are dropped before formatting', () => {
    expect(format({ or: [[{ kind: 'node', nodeId: 'a', op: '==', value: 'X' }], []] })).toBe(
      "$a.output == 'X'"
    );
  });
});

describe('when-grammar toDnf', () => {
  test('drops empty AND-groups and preserves structure', () => {
    // The parser never yields an empty group, so feed toDnf an AST that has one.
    const dnf = toDnf({
      or: [
        [{ kind: 'node', nodeId: 'a', op: '==', value: 'X' }],
        [],
        [{ kind: 'node', nodeId: 'b', op: '==', value: 'Y' }],
      ],
    });
    expect(dnf.or).toEqual([
      [{ kind: 'node', nodeId: 'a', op: '==', value: 'X' }],
      [{ kind: 'node', nodeId: 'b', op: '==', value: 'Y' }],
    ]);
  });
});
