import { describe, test, expect } from 'bun:test';
import { parse, format, toDnf } from './when-grammar';

describe('when-grammar parse', () => {
  test('parses a bare output atom', () => {
    const r = parse("$classify.output == 'BUG'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or).toEqual([[{ nodeId: 'classify', op: '==', value: 'BUG' }]]);
    }
  });

  test('parses a field atom', () => {
    const r = parse("$classify.output.type != 'FEATURE'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.or[0][0]).toEqual({
        nodeId: 'classify',
        field: 'type',
        op: '!=',
        value: 'FEATURE',
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

  test('errors on malformed input', () => {
    expect(parse('').ok).toBe(false);
    expect(parse('garbage').ok).toBe(false);
    expect(parse('$a.output ~~ 5').ok).toBe(false);
    expect(parse('$a.output == unquoted').ok).toBe(false);
  });
});

describe('when-grammar format', () => {
  test('round-trips parse → format', () => {
    const inputs = [
      "$classify.output == 'BUG'",
      "$classify.output.type != 'FEATURE'",
      "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'",
    ];
    for (const input of inputs) {
      const r = parse(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(format(r.ast)).toBe(input);
    }
  });
});

describe('when-grammar toDnf', () => {
  test('drops empty AND-groups and preserves structure', () => {
    const r = parse("$a.output == 'X' || $b.output == 'Y'");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const dnf = toDnf(r.ast);
      expect(dnf.or.length).toBe(2);
    }
  });
});
