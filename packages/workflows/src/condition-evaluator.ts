/**
 * Condition evaluator for DAG workflow `when:` expressions.
 *
 * Supports:
 *   String equality:  "$nodeId.output == 'VALUE'"  / "$nodeId.output != 'VALUE'"
 *   Dot notation:     "$nodeId.output.field == 'VALUE'"
 *   Numeric ops:      "$nodeId.output > '80'"  / ">=" / "<" / "<="
 *                     (both sides must parse as finite numbers; fail-closed otherwise)
 *   Compound AND/OR:  "$a.output == 'X' && $b.output != 'Y'"
 *                     "$a.output == 'X' || $b.output == 'Y'"
 *                     AND has higher precedence than OR. No parentheses.
 *
 * Returns true = run this node, false = skip it.
 * Invalid/unparseable expressions default to false (fail-closed = skip the node).
 */
import type { NodeOutput } from './schemas';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.condition-evaluator');
  return cachedLog;
}

/**
 * Resolve a `$nodeId.output` or `$nodeId.output.field` reference to a string value.
 * Returns empty string if the node output is not found (logs warn), if the output is
 * empty/falsy (silent), or if JSON field access fails (logs warn).
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
  if (!nodeOutput.output) return '';

  if (!field) return nodeOutput.output;

  // Dot notation: parse JSON and access field
  try {
    const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return ''; // objects, null, undefined, symbol, bigint → empty
  } catch {
    getLog().warn(
      { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100) },
      'condition_json_parse_failed'
    );
    return '';
  }
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

/** Pattern matching a single condition atom: $nodeId.output[.field] OPERATOR 'value' */
const atomPattern =
  /^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$/;

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

  const [, nodeId, field, operator, expected] = match;

  if (nodeId === undefined || operator === undefined || expected === undefined) {
    getLog().debug({ expr }, 'condition_parse_unexpected_undefined');
    return { result: false, parsed: false };
  }

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
