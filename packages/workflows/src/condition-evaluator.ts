/**
 * Condition evaluator for DAG workflow `when:` expressions.
 *
 * Supports:
 *   String equality:  "$nodeId.output == 'VALUE'"  / "$nodeId.output != 'VALUE'"
 *   Dot notation:     "$nodeId.output.field == 'VALUE'"
 *   Shorthand path:   "$nodeId.field == 'VALUE'"  (equivalent to "$nodeId.output.field")
 *   Named inputs:     "$INPUTS.mode == 'fast'"  (#2470 inputs, supplied by a caller's
 *                     `with:` — see `resolveInputRef`)
 *   Numeric ops:      "$nodeId.output > '80'"  / ">=" / "<" / "<="
 *                     (both sides must parse as finite numbers; fail-closed otherwise)
 *   Unquoted RHS:     "$nodeId.exit_code == 0"  / "$nodeId.passed == true"
 *                     (numbers and booleans may be written without surrounding quotes)
 *   Compound AND/OR:  "$a.output == 'X' && $b.output != 'Y'"
 *                     "$a.output == 'X' || $b.output == 'Y'"
 *                     AND has higher precedence than OR. No parentheses.
 *
 * The atom grammar itself lives in `when-atom.ts`, shared with the loader's load-time
 * `when:` validation so the two can never disagree about what an atom means.
 *
 * Returns true = run this node, false = skip it.
 *
 * Two different error modes:
 *   - A malformed/unparseable EXPRESSION (bad syntax) is fail-closed → result
 *     false (skip the node), parsed: false.
 *   - An unresolvable REFERENCE THROWS, propagating to FAIL the node — under the
 *     no-silent-drop contract a referenced-but-missing value is a visible failure,
 *     not a silent skip. That covers `$node.output.field` (field not in the
 *     producer's declared schema, or a schemaless node whose output isn't JSON /
 *     lacks the key) via `OutputRefError`, and an undeclared `$INPUTS.<name>` via
 *     `InputRefError`. (Declared-optional fields and whole-text `$node.output`
 *     still resolve to '' and never throw.)
 */
import type { NodeOutput } from './schemas';
import { createLogger } from '@archon/paths';
import { resolveNodeOutputField, OutputRefError, similarNodeIds } from './output-ref';
import { parseWhenAtom, splitOutsideQuotes, type WhenAtomRef } from './when-atom';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.condition-evaluator');
  return cachedLog;
}

/**
 * Resolve a `$nodeId.output` or `$nodeId.output.field` reference to a string value.
 *
 * Unknown node: whole-text `$node.output` → '' (warn); `.field` form → THROWS
 * `OutputRefError('unknown-node')` (a typo must fail, not silently resolve to '').
 * Whole-text `$node.output` on a known node → output text ('' for failed nodes).
 * For `$node.output.field`, the no-silent-drop contract (`resolveNodeOutputField`)
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
    // A `.field` ref that resolves to no output (a typo, or a real node that hasn't
    // run before this reference) fails the consuming node loudly, matching
    // `resolveNodeOutputField`'s strict no-silent-drop posture (and
    // `substituteNodeOutputRefs` in dag-executor). A whole-text `$id.output` stays
    // lenient ('').
    if (field) {
      throw new OutputRefError(
        nodeId,
        field,
        'unknown-node',
        similarNodeIds(nodeId, nodeOutputs.keys())
      );
    }
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
 * Thrown when a `when:` atom references a `$INPUTS.<name>` this run does not carry.
 *
 * Loud, never `''`: a typo'd input that silently emptied would make the condition
 * quietly false and skip the node — the exact silent-branch failure #2566 removes
 * from the whole-output case. The prompt surface already throws for the same
 * reference (`substituteWorkflowVariables` in executor-shared.ts); this is the
 * `when:` twin of it, worded the same way so an author sees one message for one
 * mistake regardless of where they made it.
 */
export class InputRefError extends Error {
  constructor(
    /** The referenced input name. Not `name` — `Error.name` is the class tag. */
    public readonly inputName: string,
    knownInputs: readonly string[]
  ) {
    super(InputRefError.messageFor(inputName, knownInputs));
    this.name = 'InputRefError';
  }

  private static messageFor(name: string, knownInputs: readonly string[]): string {
    // `similarNodeIds` is the shared did-you-mean ranker; it takes any id-like strings.
    const hint = similarNodeIds(name, knownInputs);
    const suffix =
      hint.length > 0
        ? ` Did you mean ${hint.map(h => `$INPUTS.${h}`).join(', ')}?`
        : knownInputs.length > 0
          ? ` Available inputs: ${knownInputs.map(k => `$INPUTS.${k}`).join(', ')}.`
          : ' This run has no declared inputs.';
    return `Unknown input '$INPUTS.${name}'.${suffix}`;
  }
}

/**
 * Resolve a `$INPUTS.<name>` reference to this run's input value.
 *
 * Inputs are supplied by a caller's `with:` on a `workflow:` node (or a direct run's
 * `--input`), reach the child as `metadata.inputs`, and are threaded here by the
 * executor. An undeclared name THROWS — see {@link InputRefError}.
 */
function resolveInputRef(name: string, inputs: Record<string, string> | undefined): string {
  if (inputs && Object.hasOwn(inputs, name)) return inputs[name];
  throw new InputRefError(name, inputs ? Object.keys(inputs) : []);
}

/** Resolve either kind of atom reference to the string the operator compares. */
function resolveAtomRef(
  ref: WhenAtomRef,
  nodeOutputs: Map<string, NodeOutput>,
  inputs: Record<string, string> | undefined
): string {
  return ref.kind === 'input'
    ? resolveInputRef(ref.name, inputs)
    : resolveOutputRef(ref.nodeId, ref.field, nodeOutputs);
}

/**
 * Evaluate a single atomic condition expression against upstream node outputs.
 */
function evaluateAtom(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>,
  inputs: Record<string, string> | undefined
): { result: boolean; parsed: boolean } {
  const atom = parseWhenAtom(expr);

  if (!atom) {
    getLog().debug({ expr }, 'condition_parse_failed');
    return { result: false, parsed: false };
  }

  const { ref, operator, expected } = atom;

  // Reference resolution may throw — OutputRefError for an unresolvable `.field` ref
  // (typo / schemaless non-JSON / missing key), InputRefError for an undeclared
  // `$INPUTS.<name>`. Deliberately NOT caught here: under the no-silent-drop contract
  // it must propagate to fail the node, not fail-closed to a silent skip. (Pure-syntax
  // parse failures still return {parsed:false} via the parse miss above.)
  const actual = resolveAtomRef(ref, nodeOutputs, inputs);

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
    ref.kind === 'input'
      ? { input: ref.name, operator, expected, actual, result }
      : { nodeId: ref.nodeId, field: ref.field ?? null, operator, expected, actual, result },
    'condition_evaluated'
  );
  return { result, parsed: true };
}

/**
 * Evaluate a condition expression (possibly compound) against upstream node outputs.
 *
 * @param expr - The when: expression string e.g. "$classify.output.type == 'BUG'"
 * @param nodeOutputs - Map of nodeId → NodeOutput for all settled upstream nodes (completed, failed, or skipped)
 * @param inputs - This run's named inputs (#2470), for `$INPUTS.<name>` atoms. Omitted by
 *   callers that carry no inputs; a `$INPUTS.<name>` atom then throws `InputRefError`.
 * @returns `{ result: boolean; parsed: boolean }` — result is true to run the node, false to skip;
 *   parsed is false when the expression could not be parsed (fail-closed: result defaults to false)
 */
export function evaluateCondition(
  expr: string,
  nodeOutputs: Map<string, NodeOutput>,
  inputs?: Record<string, string>
): { result: boolean; parsed: boolean } {
  const trimmed = expr.trim();

  // Split on || — OR has lower precedence
  const orClauses = splitOutsideQuotes(trimmed, '||');

  for (const orClause of orClauses) {
    // Split each OR clause on && — AND has higher precedence
    const andAtoms = splitOutsideQuotes(orClause, '&&');
    let orClauseResult = true;

    for (const atom of andAtoms) {
      const { result, parsed } = evaluateAtom(atom, nodeOutputs, inputs);
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
