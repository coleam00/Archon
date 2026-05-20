import { describe, expect, it } from 'bun:test';
import { format, parse, toDnf } from '../../lib/grammar';

describe('parse — atoms', () => {
  it('parses a single equality atom with field', () => {
    const r = parse("$classify.output.issue_type == 'bug'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: 'atom',
      ref: { nodeId: 'classify', path: ['output', 'issue_type'] },
      op: '==',
      value: 'bug',
    });
  });

  it('parses an atom without a field segment', () => {
    const r = parse("$classify.output == 'bug'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast).toEqual({
      kind: 'atom',
      ref: { nodeId: 'classify', path: ['output'] },
      op: '==',
      value: 'bug',
    });
  });

  it('parses != operator', () => {
    const r = parse("$a.output.k != 'v'");
    expect(r.ok).toBe(true);
  });

  it('parses all six operators', () => {
    for (const op of ['==', '!=', '<', '>', '<=', '>=']) {
      const r = parse(`$a.output.n ${op} '5'`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.ast as { op: string }).op).toBe(op);
    }
  });

  it('accepts hyphens in node id but not field name', () => {
    expect(parse("$my-node.output == 'x'").ok).toBe(true);
    expect(parse("$a.output.my-field == 'x'").ok).toBe(false);
  });

  it('preserves whitespace inside quoted values', () => {
    const r = parse("$a.output == ' hello world '");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.ast as { value: string }).value).toBe(' hello world ');
  });

  it('preserves && and || tokens inside quoted values', () => {
    const r = parse("$a.output == 'x && y || z'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.kind).toBe('atom');
    expect((r.ast as { value: string }).value).toBe('x && y || z');
  });
});

describe('parse — connectives', () => {
  it('parses && joining two atoms', () => {
    const r = parse("$a.output == 'x' && $b.output == 'y'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.kind).toBe('and');
  });

  it('parses || joining two atoms', () => {
    const r = parse("$a.output == 'x' || $b.output == 'y'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.kind).toBe('or');
  });

  it('parses mixed && and || with || at lower precedence', () => {
    const r = parse("$a.output == 'x' && $b.output == 'y' || $c.output == 'z'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.kind).toBe('or');
    expect(r.ast.children.length).toBe(2);
    expect(r.ast.children[0]!.kind).toBe('and');
    expect((r.ast.children[0] as { children: unknown[] }).children.length).toBe(2);
  });
});

describe('parse — rejection (fail-closed)', () => {
  it('returns Err on empty input', () => {
    expect(parse('').ok).toBe(false);
  });

  it('returns Err on whitespace-only input', () => {
    expect(parse('   ').ok).toBe(false);
  });

  it('returns Err on parens (upstream does not support them)', () => {
    expect(parse("($a.output == 'x')").ok).toBe(false);
  });

  it('returns Err on double-quoted literal', () => {
    expect(parse('$a.output == "x"').ok).toBe(false);
  });

  it('returns Err on unquoted number literal', () => {
    expect(parse('$a.output.n == 5').ok).toBe(false);
  });

  it('returns Err on unquoted boolean literal', () => {
    expect(parse('$a.output.b == true').ok).toBe(false);
  });

  it('returns Err on field path deeper than one segment', () => {
    expect(parse("$a.output.x.y == 'z'").ok).toBe(false);
  });

  it('returns Err on unsupported operator', () => {
    expect(parse("$a.output contains 'x'").ok).toBe(false);
  });

  it('returns Err on reference missing .output', () => {
    expect(parse("$a == 'x'").ok).toBe(false);
  });
});

describe('format', () => {
  function parseOk(src: string) {
    const r = parse(src);
    if (!r.ok) throw new Error(`parse failed for ${src}: ${r.error}`);
    return r.ast;
  }

  it('round-trips a simple atom (no field)', () => {
    const src = "$a.output == 'x'";
    expect(format(parseOk(src))).toBe(src);
  });

  it('round-trips an atom with field', () => {
    const src = "$classify.output.issue_type == 'bug'";
    expect(format(parseOk(src))).toBe(src);
  });

  it('round-trips && expression', () => {
    const src = "$a.output == 'x' && $b.output == 'y'";
    expect(format(parseOk(src))).toBe(src);
  });

  it('round-trips || expression', () => {
    const src = "$a.output == 'x' || $b.output == 'y'";
    expect(format(parseOk(src))).toBe(src);
  });

  it('round-trips DNF (OR of ANDs)', () => {
    const src = "$a.output == 'x' && $b.output == 'y' || $c.output == 'z'";
    expect(format(parseOk(src))).toBe(src);
  });

  it('round-trips all six operators', () => {
    for (const op of ['==', '!=', '<', '>', '<=', '>=']) {
      const src = `$a.output.n ${op} '5'`;
      expect(format(parseOk(src))).toBe(src);
    }
  });
});

describe('toDnf', () => {
  function parseOk(src: string) {
    const r = parse(src);
    if (!r.ok) throw new Error(`parse failed for ${src}: ${r.error}`);
    return r.ast;
  }

  it('returns DNF for a single atom', () => {
    const dnf = toDnf(parseOk("$a.output == 'x'"));
    expect(dnf).not.toBeNull();
    expect(dnf!.children.length).toBe(1);
    expect(dnf!.children[0]!.children.length).toBe(1);
  });

  it('returns DNF for plain AND of atoms', () => {
    const dnf = toDnf(parseOk("$a.output == 'x' && $b.output == 'y'"));
    expect(dnf).not.toBeNull();
    expect(dnf!.children.length).toBe(1);
    expect(dnf!.children[0]!.children.length).toBe(2);
  });

  it('returns DNF for OR of ANDs', () => {
    const dnf = toDnf(parseOk("$a.output == 'x' && $b.output == 'y' || $c.output == 'z'"));
    expect(dnf).not.toBeNull();
    expect(dnf!.children.length).toBe(2);
    expect(dnf!.children[0]!.children.length).toBe(2);
    expect(dnf!.children[1]!.children.length).toBe(1);
  });

  // NOTE: nested-OR-inside-AND is impossible under this parser (no parens
  // upstream), so toDnf's null-return branch is structurally unreachable from
  // parse output but kept for callers that synthesize ASTs directly (e.g. the
  // visual builder reducer).
});

describe('fixtures round-trip', () => {
  it('every when: in bundled snippets parses and re-formats stably', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../fixtures/round-trip-fixtures');
    const files = fs.readdirSync(root).filter(f => f.endsWith('.yaml'));
    // YAML quoting variant: `when: "<expr>"` (double-quoted scalar in YAML;
    // the inner expression itself uses single quotes per grammar).
    const re = /^\s*when:\s*"([^"]+)"\s*$/;
    let total = 0;
    for (const f of files) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(re);
        if (!m) continue;
        const expr = m[1]!;
        total++;
        const r = parse(expr);
        if (!r.ok) {
          throw new Error(`parse failed in ${f}: ${JSON.stringify(expr)}: ${r.error}`);
        }
        const formatted = format(r.ast);
        const r2 = parse(formatted);
        expect(r2.ok).toBe(true);
        if (!r2.ok) return;
        expect(r2.ast).toEqual(r.ast);
      }
    }
    expect(total).toBeGreaterThan(0);
  });
});
