/**
 * Pure parser/formatter for the `when:` expression grammar.
 *
 * Wire syntax per atom: `$<nodeId>.output[.<field>] <op> <rhs>` (canonical),
 * `$<nodeId>.<field> <op> <rhs>` (shorthand) or `$INPUTS.<name> <op> <rhs>` (a
 * declared workflow input), where `<rhs>` is a single-quoted string literal or a
 * bare number/boolean. `||` joins OR-clauses (outer, lower precedence) and `&&`
 * joins atoms within a clause (inner, higher precedence). Six operators:
 * `== != < > <= >=`. No parentheses. This mirrors the engine's one atom parser
 * (`WHEN_ATOM_PATTERN` plus the follow-up rules in `parseWhenAtom`,
 * packages/workflows/src/when-atom.ts) so the builder and the runtime agree on
 * what parses.
 *
 * `@archon/web` must never import `@archon/workflows` (a server package), so the
 * grammar is copied rather than shared; `scripts/node-ref-parity.test.ts` runs
 * both parsers against one corpus and compares this pattern's compiled `.source`
 * against the engine's, so the copy cannot drift silently.
 *
 * No React, no logging — errors surface via the `ParseResult` return value.
 */
import { NODE_ID_SOURCE } from '@/lib/node-ref';
import type { AtomNode, ParseResult, WhenAst, WhenOp } from '../types/when';

/** A path segment (`output`, or a field name) — no hyphen, unlike a node id. */
const SEGMENT_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_]*`;

/**
 * The reserved scope name for workflow inputs (the engine's `WHEN_INPUTS_SCOPE`).
 * It can never be a node id — the engine's node schema rejects it outright — so
 * binding the name to the input scope here cannot shadow a real node.
 */
const INPUTS_SCOPE = 'INPUTS';

/**
 * An input name, as the engine's `with:` key validator defines it
 * (`INPUT_NAME_SOURCE` in packages/workflows/src/schemas/dag-node.ts).
 *
 * Identical to `NODE_ID_SOURCE` today, and kept separate anyway: they are
 * different vocabularies that happen to coincide, and writing the coincidence
 * into the code would hide a future widening of one from the reader.
 */
const INPUT_NAME_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_-]*`;

/**
 * Single-atom pattern, mirroring the engine's `WHEN_ATOM_PATTERN`:
 *   1. inputName — `$INPUTS.<name>` (the input branch; tried first)
 *   2. nodeId    — `$nodeId`, using the package-wide id grammar (`@/lib/node-ref`)
 *   3. segment1  — first path segment (`output` for canonical refs, else a
 *                  shorthand field name)
 *   4. segment2  — optional second segment (the field name when segment1 is `output`)
 *   5. op        — one of the six operators
 *   6. quoted    — single-quoted RHS literal (may be empty)
 *   7. bare      — unquoted RHS: number (`-?\d+(.\d+)?`) or `true`/`false`
 *
 * Exactly one of groups 6/7 is populated on a successful match.
 *
 * The input branch is first so `$INPUTS.mode` binds to the input scope. `$INPUTS.a.b`
 * fails that branch (an input name cannot carry a sub-field) and backtracks into the
 * node branch, where `parseAtom` rejects the reserved id explicitly — exactly as the
 * engine's `parseWhenAtom` does.
 *
 * Exported for the cross-package parity check; the builder's own API is
 * `parse`/`format`.
 */
export const ATOM_PATTERN = new RegExp(
  '^(?:' +
    String.raw`\$${INPUTS_SCOPE}\.(${INPUT_NAME_SOURCE})` +
    '|' +
    String.raw`\$(${NODE_ID_SOURCE})\.(${SEGMENT_SOURCE})(?:\.(${SEGMENT_SOURCE}))?` +
    ')' +
    String.raw`\s*(==|!=|<=|>=|<|>)\s*` +
    String.raw`(?:'([^']*)'|(-?\d+(?:\.\d+)?|true|false))$`
);

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
  const [, inputName, nodeId, segment1, segment2, op, quoted, bare] = match;
  if (op === undefined) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }

  const rhs = quoted !== undefined ? quoted : bare;
  if (rhs === undefined) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }
  const spelling = quoted === undefined ? { bare: true as const } : {};

  if (inputName !== undefined) {
    return {
      ok: true,
      atom: { kind: 'input', name: inputName, op: op as WhenOp, value: rhs, ...spelling },
    };
  }

  if (nodeId === undefined || segment1 === undefined) {
    return { ok: false, error: `cannot parse condition: "${trimmed}"` };
  }

  // Reached only by `$INPUTS.<a>.<b>` backtracking out of the input branch above: no
  // node can carry the reserved id, so this is a malformed input ref rather than a
  // node reference. The engine's parseWhenAtom rejects it the same way.
  if (nodeId === INPUTS_SCOPE) {
    return {
      ok: false,
      error: `cannot parse condition: "${trimmed}" ('$${INPUTS_SCOPE}.<name>' names a workflow input and cannot carry a sub-field)`,
    };
  }

  // Canonical-vs-shorthand path resolution, matching the engine's parseWhenAtom:
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

  const atom: AtomNode = {
    kind: 'node',
    nodeId,
    op: op as WhenOp,
    value: rhs,
    ...(field !== undefined ? { field } : {}),
    ...(shorthand ? { shorthand: true } : {}),
    ...spelling,
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

/** The wire spelling of an atom's left-hand side. */
function formatRef(atom: AtomNode): string {
  if (atom.kind === 'input') return `$${INPUTS_SCOPE}.${atom.name}`;
  if (atom.shorthand && atom.field !== undefined) return `$${atom.nodeId}.${atom.field}`;
  if (atom.field !== undefined) return `$${atom.nodeId}.output.${atom.field}`;
  return `$${atom.nodeId}.output`;
}

/** Format a single atom back to wire syntax, preserving the author's spelling. */
function formatAtom(atom: AtomNode): string {
  const path = formatRef(atom);
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
