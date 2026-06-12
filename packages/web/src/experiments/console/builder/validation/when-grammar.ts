/**
 * Pure parser/formatter for the `when:` expression grammar.
 *
 * Wire syntax per atom: `$<nodeId>.output[.<field>] <op> <rhs>` (canonical) or
 * `$<nodeId>.<field> <op> <rhs>` (shorthand), where `<rhs>` is a single-quoted
 * string literal or a bare number/boolean. `||` joins OR-clauses (outer, lower
 * precedence) and `&&` joins atoms within a clause (inner, higher precedence).
 * Six operators: `== != < > <= >=`. No parentheses. This mirrors the engine's
 * condition-evaluator grammar (`atomPattern` plus the shorthand sub-field
 * rejection in `evaluateAtom`, packages/workflows/src/condition-evaluator.ts)
 * so the builder and the runtime agree on what parses.
 *
 * No React, no logging — errors surface via the `ParseResult` return value.
 */
import type { AtomNode, ParseResult, WhenAst, WhenOp } from '../types';

/**
 * Single-atom pattern, mirroring the engine's `atomPattern`:
 *   1. nodeId   — `$nodeId` (letters/digits/underscore/hyphen, no leading digit)
 *   2. segment1 — first path segment (`output` for canonical refs, else a
 *                 shorthand field name)
 *   3. segment2 — optional second segment (the field name when segment1 is `output`)
 *   4. op       — one of the six operators
 *   5. quoted   — single-quoted RHS literal (may be empty)
 *   6. bare     — unquoted RHS: number (`-?\d+(.\d+)?`) or `true`/`false`
 *
 * Exactly one of groups 5/6 is populated on a successful match.
 */
const ATOM_PATTERN =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?|true|false))$/;

/** RHS spellings that are valid bare (unquoted) — used by `formatAtom` as a guard. */
const BARE_VALUE_PATTERN = /^(-?\d+(\.\d+)?|true|false)$/;

/**
 * Split a string on a separator, but only when not inside a single-quoted region.
 * Always returns at least one element.
 */
function splitOutsideQuotes(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      inQuote = !inQuote;
      current += expr[i];
      i += 1;
    } else if (!inQuote && expr.startsWith(sep, i)) {
      parts.push(current.trim());
      current = '';
      i += sep.length;
    } else {
      current += expr[i];
      i += 1;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** Parse a single atom. Returns the atom, or an error message. */
function parseAtom(raw: string): { ok: true; atom: AtomNode } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty condition atom' };
  }
  const match = ATOM_PATTERN.exec(trimmed);
  if (!match) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }
  const [, nodeId, segment1, segment2, op, quoted, bare] = match;
  if (nodeId === undefined || segment1 === undefined || op === undefined) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }

  // Canonical-vs-shorthand path resolution, matching the engine's evaluateAtom:
  //   `$node.output`        → bare output reference (field undefined)
  //   `$node.output.field`  → field access on the output
  //   `$node.field`         → shorthand, equivalent to `$node.output.field`
  // The shorthand form cannot carry a sub-field (the engine rejects it fail-closed).
  let field: string | undefined;
  let shorthand = false;
  if (segment1 === 'output') {
    field = segment2;
  } else {
    if (segment2 !== undefined) {
      return {
        ok: false,
        error: `cannot parse condition: "${trimmed}" (shorthand '$${nodeId}.${segment1}' cannot carry a sub-field — use '$${nodeId}.output.${segment1}.…')`,
      };
    }
    shorthand = true;
    field = segment1;
  }

  const value = quoted !== undefined ? quoted : bare;
  if (value === undefined) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }

  const atom: AtomNode = {
    nodeId,
    op: op as WhenOp,
    value,
    ...(field !== undefined ? { field } : {}),
    ...(shorthand ? { shorthand: true } : {}),
    ...(quoted === undefined ? { bare: true } : {}),
  };
  return { ok: true, atom };
}

/**
 * Parse a `when:` expression into a DNF AST (outer OR of inner AND-groups).
 * Returns `{ ok: false, error }` on the first malformed atom (fail-closed).
 */
export function parse(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty when expression' };
  }

  const orClauses = splitOutsideQuotes(trimmed, '||');
  const or: AtomNode[][] = [];

  for (const clause of orClauses) {
    const andParts = splitOutsideQuotes(clause, '&&');
    const group: AtomNode[] = [];
    for (const part of andParts) {
      const result = parseAtom(part);
      if (!result.ok) return { ok: false, error: result.error };
      group.push(result.atom);
    }
    or.push(group);
  }

  return { ok: true, ast: { or } };
}

/** Format a single atom back to wire syntax, preserving the author's spelling. */
function formatAtom(atom: AtomNode): string {
  const path =
    atom.shorthand && atom.field !== undefined
      ? `$${atom.nodeId}.${atom.field}`
      : atom.field !== undefined
        ? `$${atom.nodeId}.output.${atom.field}`
        : `$${atom.nodeId}.output`;
  // Bare spelling is only valid for number/boolean RHS — quote anything else so a
  // hand-built AST cannot format to an unparseable expression.
  const rhs = atom.bare && BARE_VALUE_PATTERN.test(atom.value) ? atom.value : `'${atom.value}'`;
  return `${path} ${atom.op} ${rhs}`;
}

/**
 * Format a DNF AST back to a `when:` expression string. Empty AND-groups are
 * dropped first; an AST with no remaining atoms formats to `undefined` (an
 * empty `when:` is "no condition" — never the empty string, which would write
 * an unparseable `when: ''` to the wire).
 */
export function format(ast: WhenAst): string | undefined {
  const dnf = toDnf(ast);
  if (dnf.or.length === 0) return undefined;
  return dnf.or.map(group => group.map(formatAtom).join(' && ')).join(' || ');
}

/**
 * Normalize an AST to disjunctive normal form. The grammar already produces DNF
 * (OR of ANDs with no nesting), so this drops empty AND-groups and returns a
 * stable structure. Provided for symmetry with the studio's API and PR-2 use.
 */
export function toDnf(ast: WhenAst): WhenAst {
  return { or: ast.or.filter(group => group.length > 0) };
}
