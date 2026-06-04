/**
 * Pure parser/formatter for the `when:` expression grammar.
 *
 * Wire syntax: `$<nodeId>.output[.<field>] <op> '<value>'`, with `||` joining
 * OR-clauses (outer, lower precedence) and `&&` joining atoms within a clause
 * (inner, higher precedence). Six operators: `== != < > <= >=`. RHS values are
 * single-quoted. No parentheses. This mirrors the engine's condition-evaluator
 * grammar (packages/workflows/src/condition-evaluator.ts) so the builder and the
 * runtime agree on what parses.
 *
 * No React, no logging — errors surface via the `ParseResult` return value.
 */
import type { AtomNode, ParseResult, WhenAst, WhenOp } from '../types';

/**
 * Single-atom pattern: `$nodeId.output[.field] op 'value'`.
 *   1. nodeId — `$nodeId` (letters/digits/underscore/hyphen, no leading digit)
 *   2. field  — optional segment after `.output.`
 *   3. op     — one of the six operators
 *   4. value  — single-quoted literal (may be empty)
 */
const ATOM_PATTERN =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$/;

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
  const [, nodeId, field, op, value] = match;
  if (nodeId === undefined || op === undefined || value === undefined) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }
  const atom: AtomNode = {
    nodeId,
    op: op as WhenOp,
    value,
    ...(field !== undefined ? { field } : {}),
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

/** Format a single atom back to wire syntax. */
function formatAtom(atom: AtomNode): string {
  const path =
    atom.field !== undefined ? `$${atom.nodeId}.output.${atom.field}` : `$${atom.nodeId}.output`;
  return `${path} ${atom.op} '${atom.value}'`;
}

/** Format a DNF AST back to a `when:` expression string. */
export function format(ast: WhenAst): string {
  return ast.or.map(group => group.map(formatAtom).join(' && ')).join(' || ');
}

/**
 * Normalize an AST to disjunctive normal form. The grammar already produces DNF
 * (OR of ANDs with no nesting), so this drops empty AND-groups and returns a
 * stable structure. Provided for symmetry with the studio's API and PR-2 use.
 */
export function toDnf(ast: WhenAst): WhenAst {
  return { or: ast.or.filter(group => group.length > 0) };
}
