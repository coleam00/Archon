/**
 * The one parser for a `when:` ATOM — the smallest complete comparison a `when:`
 * expression is built from (`$ref.path <op> <literal>`).
 *
 * Two consumers share it on purpose:
 *   - `condition-evaluator.ts` EVALUATES atoms at run time;
 *   - `loader.ts` VALIDATES them at load time (#2566), which needs the same
 *     decomposition to tell a whole-output `$node.output` from a field access
 *     `$node.output.field` — a distinction the loader's coarse `WHEN_REF_SOURCE`
 *     ref sweep cannot make, because it captures only the first path segment.
 *
 * A second hand-written copy of this grammar is precisely the drift the
 * "KEEP IN SYNC" comment in `loader.ts` already exists to warn about, so the
 * grammar lives here once and nowhere else.
 *
 * Grammar (compound expressions are split into atoms by {@link whenAtoms}):
 *   $nodeId.output            — whole output text of a node
 *   $nodeId.output.field      — a field of a node's JSON output
 *   $nodeId.field             — shorthand for the line above (cannot nest)
 *   $INPUTS.name              — a named workflow input (#2470)
 *   <op> is == != <= >= < >, RHS is a single-quoted literal or a bare
 *   number/boolean.
 */
import { INPUT_NAME_SOURCE } from './schemas/dag-node';

/**
 * The reserved scope name for workflow inputs. `loader.ts` imports this rather than
 * re-typing the literal in its two ref scans. It is NOT the only spelling in the tree —
 * `include-expander.ts` and `executor-shared.ts` still hardcode the word, and
 * `dagNodeSchema` (which enforces the reservation) cannot import it back without a cycle.
 *
 * `INPUTS` can never be a node id: `dagNodeSchema.superRefine` rejects it outright
 * ("node id 'INPUTS' is reserved for the $INPUTS.<name> parameter surface"). So binding
 * the name to the input scope here cannot shadow a real node — there is none to shadow.
 */
export const WHEN_INPUTS_SCOPE = 'INPUTS';

/**
 * Operators `when:` accepts, in regex-alternation order (`<=` before `<`, or the
 * shorter operator would win and leave a stray `=` on the right-hand side).
 * The pattern below is built from this list so the type and the grammar cannot drift.
 */
const WHEN_OPERATORS = ['==', '!=', '<=', '>=', '<', '>'] as const;

export type WhenOperator = (typeof WHEN_OPERATORS)[number];

function isWhenOperator(value: string): value is WhenOperator {
  return (WHEN_OPERATORS as readonly string[]).includes(value);
}

/** A node id may contain hyphens; a path segment (a JSON field name) may not. */
const NODE_ID_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_-]*`;
const PATH_SEGMENT_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_]*`;

/**
 * Capture groups:
 *   1. inputName   — `$INPUTS.<name>` (the input branch; tried first)
 *   2. nodeId      — `$nodeId`
 *   3. segment1    — first path segment (`output` for canonical refs, else a shorthand field)
 *   4. segment2    — optional second segment (the field name when segment1 is `output`)
 *   5. operator
 *   6. quotedValue — single-quoted RHS literal (may be empty)
 *   7. unquotedValue — bare numeric or boolean RHS
 *
 * The input branch is first so `$INPUTS.mode` binds to the input scope. `$INPUTS.a.b`
 * fails that branch (an input name cannot carry a sub-field) and backtracks into the
 * node branch, where {@link parseWhenAtom} rejects the reserved id explicitly.
 *
 * Exported for `scripts/node-ref-parity.test.ts`, which compares `.source` against the
 * web builder's hand-maintained copy of this grammar. Comparing the COMPILED pattern is
 * what makes that check immune to how either side spells its composition — the previous
 * text-scraping version broke the moment this constant became a `new RegExp(...)`
 * concatenation. No engine code outside this module reads it — `parseWhenAtom` is the
 * API, and callers that reach for the pattern instead are re-implementing it.
 */
export const WHEN_ATOM_PATTERN = new RegExp(
  '^(?:' +
    String.raw`\$${WHEN_INPUTS_SCOPE}\.(${INPUT_NAME_SOURCE})` +
    '|' +
    String.raw`\$(${NODE_ID_SOURCE})\.(${PATH_SEGMENT_SOURCE})(?:\.(${PATH_SEGMENT_SOURCE}))?` +
    ')' +
    String.raw`\s*(${WHEN_OPERATORS.join('|')})\s*` +
    String.raw`(?:'([^']*)'|(-?\d+(?:\.\d+)?|true|false))$`
);

/** What the left-hand side of an atom refers to. */
export type WhenAtomRef =
  | {
      kind: 'node';
      nodeId: string;
      /** `undefined` for a whole-output `$node.output`; the field name otherwise. */
      field: string | undefined;
    }
  | { kind: 'input'; name: string };

export interface WhenAtom {
  ref: WhenAtomRef;
  operator: WhenOperator;
  /** The right-hand literal, already unquoted. */
  expected: string;
}

/**
 * Split a string on a separator, but only when not inside single-quoted regions.
 * Returns at least one element (the full trimmed string if no split occurs).
 */
export function splitOutsideQuotes(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      inQuote = !inQuote;
      current += expr[i++];
    } else if (!inQuote && expr.startsWith(sep, i)) {
      parts.push(current.trim());
      current = '';
      i += sep.length;
    } else {
      current += expr[i++];
    }
  }
  parts.push(current.trim());
  return parts;
}

/**
 * Every atom string in a (possibly compound) `when:` expression, in source order.
 *
 * Flattens the `||` / `&&` structure away — callers that need the boolean structure
 * (the evaluator) split with {@link splitOutsideQuotes} themselves; callers that only
 * need to inspect each comparison (the loader) use this.
 */
export function whenAtoms(expr: string): string[] {
  return splitOutsideQuotes(expr.trim(), '||').flatMap(clause => splitOutsideQuotes(clause, '&&'));
}

/**
 * Parse one atom. Returns `null` when the text is not a well-formed atom — every
 * caller treats that as a parse failure (the evaluator fails closed and skips the
 * node; the loader leaves the atom to that runtime behaviour).
 */
export function parseWhenAtom(expr: string): WhenAtom | null {
  const match = WHEN_ATOM_PATTERN.exec(expr.trim());
  if (!match) return null;

  const [, inputName, nodeId, segment1, segment2, operator, quotedValue, unquotedValue] = match;

  // Quoted RHS takes precedence; the unquoted alternative covers numbers and booleans.
  const expected = quotedValue !== undefined ? quotedValue : unquotedValue;
  if (operator === undefined || !isWhenOperator(operator) || expected === undefined) return null;

  if (inputName !== undefined) {
    return { ref: { kind: 'input', name: inputName }, operator, expected };
  }

  if (nodeId === undefined || segment1 === undefined) return null;
  // Reached only by `$INPUTS.<a>.<b>` backtracking out of the input branch. No node can
  // carry the reserved id, so this is a malformed input ref, not a node reference.
  if (nodeId === WHEN_INPUTS_SCOPE) return null;

  // Resolve the effective field, preserving canonical `$node.output[.field]` semantics
  // while also accepting the `$node.field` shorthand:
  //   - `$node.output`        → whole-output reference (field undefined)
  //   - `$node.output.field`  → field access on the output
  //   - `$node.field`         → shorthand, equivalent to `$node.output.field`
  // The shorthand form cannot carry a sub-field (`$node.field.sub` is rejected).
  if (segment1 === 'output') {
    return { ref: { kind: 'node', nodeId, field: segment2 }, operator, expected };
  }
  if (segment2 !== undefined) return null;
  return { ref: { kind: 'node', nodeId, field: segment1 }, operator, expected };
}
