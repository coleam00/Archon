/**
 * Condition evaluator for DAG workflow `when:` expressions.
 *
 * Supports:
 *   String equality:  "$nodeId.output == 'VALUE'"  / "$nodeId.output != 'VALUE'"
 *   Dot notation:     "$nodeId.output.field == 'VALUE'"
 *   Shorthand path:   "$nodeId.field == 'VALUE'"  (equivalent to "$nodeId.output.field")
 *   Numeric ops:      "$nodeId.output > '80'"  / ">=" / "<" / "<="
 *                     (both sides must parse as finite numbers; fail-closed otherwise)
 *   Unquoted RHS:     "$nodeId.exit_code == 0"  / "$nodeId.passed == true"
 *                     (numbers and booleans may be written without surrounding quotes)
 *   Compound AND/OR:  "$a.output == 'X' && $b.output != 'Y'"
 *                     "$a.output == 'X' || $b.output == 'Y'"
 *                     AND has higher precedence than OR. No parentheses.
 *
 * Returns true = run this node, false = skip it.
 *
 * Two different error modes:
 *   - A malformed/unparseable EXPRESSION (bad syntax) is fail-closed → result
 *     false (skip the node), parsed: false.
 *   - An unresolvable `$node.output.field` REFERENCE (field not in the producer's
 *     declared schema, or a schemaless node whose output isn't JSON / lacks the
 *     key) THROWS an `OutputRefError` that propagates to FAIL the node — under the
 *     no-silent-drop contract a referenced-but-missing value is a visible failure,
 *     not a silent skip. (Declared-optional fields and whole-text `$node.output`
 *     still resolve to '' and never throw.)
 */
import type { NodeOutput } from './schemas';
import { createLogger } from '@archon/paths';
import { resolveNodeOutputField } from './output-ref';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.condition-evaluator');
  return cachedLog;
}

/**
 * Resolve a `$nodeId.output` or `$nodeId.output.field` reference to a string value.
 *
 * Unknown node → '' (warn). Whole-text `$node.output` → output text ('' for failed
 * nodes). For `$node.output.field`, the no-silent-drop contract (`resolveNodeOutputField`)
 * applies: a declared-optional-absent field resolves to ''; a field not in the
 * producer's schema, or a schemaless node whose output isn't JSON / lacks the key,
 * THROWS an `OutputRefError` that propagates to fail the consuming node (no silent skip).
 */
function resolveOutputRef(
  nodeId: string,
  field: string | undefined,
  nodeOutputs: Map<string, NodeOutput>
): string {
  const nodeOutput = nodeOutputs.get(nodeId);
  if (!nodeOutput) {
    getLog().warn({ nodeId }, 'condition_output_ref_unknown_node');
    return '';
  }
  if (!field) {
    // For unfielded ref, structuredOutput shape is opaque — defer to output text (which is
    // empty for failed nodes, matching the historical fail-closed contract).
    if (!nodeOutput.output) return '';
    return nodeOutput.output;
  }

  const resolution = resolveNodeOutputField(nodeOutput, nodeId, field);
  if (resolution.kind === 'empty') return '';
  const value = resolution.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Arrays, objects, AND null are JSON-stringified here (typeof null === 'object').
  // A present null on the lenient no-schema path stringifies to "null", matching
  // legacy structuredOutput-preference behavior — it is NOT mapped to empty.
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return ''; // defensive: JSON.parse can't yield undefined/symbol/bigint
}

/**
 * Split a string on a separator, but only when not inside single-quoted regions.
 * Returns at least one element (the full trimmed string if no split occurs).
 */
function splitOutsideQuotes(expr: string, sep: string): string[] {
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
 * Pattern matching a single condition atom.
 *
 * Capture groups:
 *   1. nodeId       — `$nodeId`
 *   2. segment1     — first path segment after the node (`output` for canonical refs, else a
 *                     shorthand field name)
 *   3. segment2     — optional second path segment (the field name when segment1 is `output`)
 *   4. operator     — `== | != | <= | >= | < | >`
 *   5. quotedValue  — single-quoted RHS literal (may be empty)
 *   6. unquotedValue — bare numeric or boolean RHS (`-?\d+(.\d+)?` | `true` | `false`)
 *
 * Exactly one of groups 5/6 is populated on a successful match. The canonical-vs-shorthand
 * path resolution and the sub-field rejection happen in evaluateAtom.
 */
const atomPattern =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?|true|false))$/;

/**
 * Evaluate a single atomic condition expression against upstream node outputs.
 */
function evaluateAtom(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>
): { result: boolean; parsed: boolean } {
  const trimmed = expr.trim();
  const match = atomPattern.exec(trimmed);

  if (!match) {
    getLog().debug({ expr }, 'condition_parse_failed');
    return { result: false, parsed: false };
  }

  const [, nodeId, segment1, segment2, operator, quotedValue, unquotedValue] = match;

  if (nodeId === undefined || segment1 === undefined || operator === undefined) {
    getLog().debug({ expr }, 'condition_parse_unexpected_undefined');
    return { result: false, parsed: false };
  }

  // Resolve the effective field, preserving the canonical `$node.output[.field]` semantics
  // while also accepting the `$node.field` shorthand:
  //   - `$node.output`        → bare output reference (field undefined)
  //   - `$node.output.field`  → field access on the output
  //   - `$node.field`         → shorthand, equivalent to `$node.output.field`
  // The shorthand form cannot carry a sub-field (`$node.field.sub` is rejected fail-closed).
  let field: string | undefined;
  if (segment1 === 'output') {
    field = segment2;
  } else {
    if (segment2 !== undefined) {
      getLog().debug({ expr }, 'condition_parse_failed');
      return { result: false, parsed: false };
    }
    field = segment1;
  }

  // Quoted RHS takes precedence; the unquoted alternative covers numbers and booleans.
  const expected = quotedValue !== undefined ? quotedValue : unquotedValue;
  if (expected === undefined) {
    getLog().debug({ expr }, 'condition_parse_unexpected_undefined');
    return { result: false, parsed: false };
  }

  // resolveOutputRef may throw OutputRefError for an unresolvable `.field` ref
  // (typo / schemaless non-JSON / missing key). It is deliberately NOT caught
  // here — under the no-silent-drop contract it must propagate to fail the node,
  // not fail-closed to a silent skip. (Pure-syntax parse failures still return
  // {parsed:false} via the atomPattern miss above and remain fail-closed.)
  const actual = resolveOutputRef(nodeId, field, nodeOutputs);

  let result: boolean;
  if (operator === '==' || operator === '!=') {
    result = operator === '==' ? actual === expected : actual !== expected;
  } else {
    // Numeric comparison
    const actualNum = parseFloat(actual);
    const expectedNum = parseFloat(expected);
    if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) {
      getLog().debug({ expr, actual, expected }, 'condition_numeric_parse_failed');
      return { result: false, parsed: false };
    }
    if (operator === '<') result = actualNum < expectedNum;
    else if (operator === '>') result = actualNum > expectedNum;
    else if (operator === '<=') result = actualNum <= expectedNum;
    else result = actualNum >= expectedNum; // '>='
  }

  getLog().debug(
    { nodeId, field: field ?? null, operator, expected, actual, result },
    'condition_evaluated'
  );
  return { result, parsed: true };
}

/**
 * Evaluate a condition expression (possibly compound) against upstream node outputs.
 *
 * @param expr - The when: expression string e.g. "$classify.output.type == 'BUG'"
 * @param nodeOutputs - Map of nodeId → NodeOutput for all settled upstream nodes (completed, failed, or skipped)
 * @returns `{ result: boolean; parsed: boolean }` — result is true to run the node, false to skip;
 *   parsed is false when the expression could not be parsed (fail-closed: result defaults to false)
 */
export function evaluateCondition(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>
): { result: boolean; parsed: boolean } {
  const trimmed = expr.trim();

  // Split on || — OR has lower precedence
  const orClauses = splitOutsideQuotes(trimmed, '||');

  for (const orClause of orClauses) {
    // Split each OR clause on && — AND has higher precedence
    const andAtoms = splitOutsideQuotes(orClause, '&&');
    let orClauseResult = true;

    for (const atom of andAtoms) {
      const { result, parsed } = evaluateAtom(atom, nodeOutputs);
      if (!parsed) return { result: false, parsed: false }; // fail-closed on any parse error
      if (!result) {
        orClauseResult = false;
        break; // short-circuit AND
      }
    }

    if (orClauseResult) return { result: true, parsed: true }; // short-circuit OR
  }

  return { result: false, parsed: true };
}
