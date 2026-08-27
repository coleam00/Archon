/**
 * Strict resolution for `$nodeId.output.field` references (no-silent-drop).
 *
 * Shared by both consumers — prompt/script substitution (`substituteNodeOutputRefs`
 * in dag-executor) and `when:` evaluation (`resolveOutputRef` in condition-evaluator)
 * — so the contract is identical in both.
 *
 * Resolution table for a known producer:
 *   0. Producer's `state` is `'failed'` → THROW ('producer-failed', #2713), before any
 *      of the branches below ever run — a failed producer's leftover output is never
 *      trusted, however JSON-shaped or non-empty it looks.
 *   1. Producer HAS `declaredFields` (an `output_format` with `properties`) — enforce it:
 *        field ∈ declaredFields, value present      → value
 *        field ∈ declaredFields, value absent/null  → '' (declared-optional / explicit null)
 *        field ∉ declaredFields                      → THROW (typo / not in the contract)
 *        output is not a JSON object at all          → THROW (#2456 — a declared schema is
 *                                                      never quieter than no schema; the
 *                                                      leniency above covers a missing KEY
 *                                                      in a parsed object, not a missing object)
 *
 *   Either THROW-on-unparseable above reports reason 'truncated' instead of
 *   'unparseable' when the output carries the persistence truncation marker — same
 *   parse failure, but the producer was right and a resumed run is reading a clipped
 *   copy, so the author needs opposite advice. See utils/output-truncation.ts.
 *   2. Has a `structuredOutput` object but NO `declaredFields` (legacy rows, or a
 *      non-object schema) — prefer it, but stay LENIENT: with no declared schema we
 *      can't tell optional-absent from a typo, so:
 *        key present → value ;  key absent → '' (no throw — backward compatible)
 *   3. Schemaless (bash/script/prose) — the author wrote `.field`, so JSON with that
 *      key is expected; anything else is a drop they must see:
 *        output not a JSON object → THROW ;  key present → value ;  key absent → THROW
 *
 * The whole-text `$node.output` form (no `.field`) is never routed through THIS
 * function — but it is no longer unconditionally lenient: every caller (#2713) now
 * guards it, before ever reading the producer's output, through `assertProducerNotFailed`
 * below — the same `state === 'failed'` case this function guards for the fielded form,
 * as one shared function every caller routes through (#2722), replacing the enumeration
 * of independently-worded call sites that each had to remember the check.
 *
 * The UNKNOWN-node case (`$typo.output.field` where nothing in the outputs map
 * resolves — a typo, or a real node that has not run before the reference) is
 * handled by the callers, not `resolveNodeOutputField` — they own the outputs map.
 * A `.field` ref to such an id throws `OutputRefError('unknown-node')` there, so it
 * fails the consuming node loudly, consistent with the strict field posture above;
 * a whole-text `$typo.output` to an unresolved id stays lenient ('') on the
 * long-documented prompt/script surfaces. `until_bash` opts into a required-output
 * policy at its substitution call sites because an empty fallback would decide loop
 * completion. See `similarNodeIds`.
 */
import { z } from '@hono/zod-openapi';
import type { NodeOutput } from './schemas';
import { findSimilar } from './utils/fuzzy-match';
import { hasTruncationMarker } from './utils/output-truncation';

// ---------------------------------------------------------------------------
// Workflow values (#2637)
// ---------------------------------------------------------------------------

/**
 * A workflow value: any JSON-compatible logical value (string, number, boolean,
 * null, array, object). This is the type `with:` maps, `inputs:` defaults, and
 * whole-value bindings carry — `undefined` is rejected (a binding either has a
 * value or fails loudly; it is never silently absent).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown;
    return (
      (proto === Object.prototype || proto === null) && Object.values(value).every(isJsonValue)
    );
  }
  return false;
}

/**
 * Deliberately NOT `z.json()`: zod's built-in recursive JSON schema blows the
 * stack when @hono/zod-openapi walks it for spec generation (the engine's
 * workflow schemas are embedded in server route schemas). A refined `unknown`
 * validates the same value set — rejects `undefined`, non-finite numbers, and
 * non-plain objects like Date — while serializing to OpenAPI as an
 * unconstrained value, which is exactly what "any JSON value" means there.
 * The explicit `z.ZodType<JsonValue>` annotation (through the checked guard)
 * is the project's sanctioned recursive-type escape hatch — structural drift
 * between the guard and the type is a compile error at the cast site.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.unknown().refine(isJsonValue, {
  message: 'must be a JSON-compatible value (string, number, boolean, null, array, or object)',
}) as unknown as z.ZodType<JsonValue>;

/**
 * THE deterministic value→text rule (#2637): embedding a workflow value in
 * surrounding text uses exactly one representation — strings raw, everything
 * else canonical JSON text.
 *
 * One line on purpose: for the non-string JSON types, `String(number|boolean)`
 * is byte-identical to `JSON.stringify` (JSON has no NaN/Infinity), and null,
 * arrays, and objects have only their JSON form — so a single `JSON.stringify`
 * covers them all. Callers that need bash escaping or unquoted numerics decide
 * that at the call site; this rule owns only the text.
 *
 * The `?? ''` covers the values JSON.stringify cannot represent (undefined,
 * symbols, functions) — unreachable from parsed JSON, kept as the same
 * defensive empty the pre-extraction call sites had.
 */
export function canonicalValueText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * The one shape of a `$nodeId.output` reference — shared with the loader's
 * dangling-ref scan and every scanner that must agree with it (KEEP IN SYNC
 * list in loader.ts). Scanners build their own RegExp from this source (a
 * `g`-flagged instance carries mutable lastIndex and must not be shared).
 */
export const OUTPUT_REF_SOURCE = String.raw`\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output`;

/**
 * The one shape of a declared-input NAME — `with:` keys, `inputs:` keys, and the
 * `<name>` of a `$INPUTS.<name>` reference all share it. Lives here beside
 * OUTPUT_REF_SOURCE so every ref grammar has one home; schemas/dag-node re-exports
 * it for the schema-side validators.
 */
export const INPUT_NAME_SOURCE = String.raw`[a-zA-Z_][a-zA-Z0-9_-]*`;

/** Anchored whole-value form: the ENTIRE (trimmed) string is one `$INPUTS.<name>` ref. */
const WHOLE_INPUTS_REF_PATTERN = new RegExp(String.raw`^\$INPUTS\.(${INPUT_NAME_SOURCE})$`);

/**
 * Parse a string that is exactly one whole `$INPUTS.<name>` reference (after
 * trimming) to its input name, or undefined for anything else. The `$INPUTS`
 * sibling of {@link parseWholeOutputRef}: binding value positions use both to
 * decide "forward the logical value" vs "splice text into a template".
 */
export function parseWholeInputsRef(text: string): string | undefined {
  return WHOLE_INPUTS_REF_PATTERN.exec(text.trim())?.[1];
}

/** Resolve every runtime `$INPUTS.<name>` reference in a text surface. */
export function substituteInputRefs(
  text: string,
  inputs: Record<string, JsonValue> | undefined
): string {
  const pattern = new RegExp(String.raw`\$INPUTS\.(${INPUT_NAME_SOURCE})`, 'g');
  return text.replace(pattern, (_match, name: string) => {
    if (inputs && Object.hasOwn(inputs, name)) return canonicalValueText(inputs[name]);
    const known = inputs ? Object.keys(inputs) : [];
    const hint = similarNodeIds(name, known);
    const suffix =
      hint.length > 0
        ? ` Did you mean ${hint.map(candidate => `$INPUTS.${candidate}`).join(', ')}?`
        : known.length > 0
          ? ` Available inputs: ${known.map(candidate => `$INPUTS.${candidate}`).join(', ')}.`
          : ' This run has no declared inputs.';
    throw new Error(`Unknown input '$INPUTS.${name}'.${suffix}`);
  });
}

/** Anchored whole-value form: the ENTIRE (trimmed) string is one `$id.output[.field]` ref. */
const WHOLE_OUTPUT_REF_PATTERN = new RegExp(
  `^${OUTPUT_REF_SOURCE}(?:\\.([a-zA-Z_][a-zA-Z0-9_]*))?$`
);

/**
 * Parse a string that is exactly one whole `$node.output[.field]` reference
 * (after trimming), or undefined when it is anything else — a literal, a
 * template with surrounding text, or not a ref at all. This is what lets a
 * binding value distinguish "pass the logical value through" from "splice text
 * into a template" without inventing a second ref grammar.
 */
export function parseWholeOutputRef(text: string): { nodeId: string; field?: string } | undefined {
  const m = WHOLE_OUTPUT_REF_PATTERN.exec(text.trim());
  if (!m) return undefined;
  return { nodeId: m[1], ...(m[2] !== undefined ? { field: m[2] } : {}) };
}

/**
 * Thrown when a `$nodeId.output.field` reference cannot be honored under the
 * no-silent-drop contract. Propagates to fail the consuming node (both call
 * sites run inside the dag-executor's per-node try/catch).
 */
export type OutputRefErrorReason =
  | 'not-in-schema'
  | 'unparseable'
  | 'truncated'
  | 'array-aggregate'
  | 'missing-key'
  | 'producer-not-run'
  | 'producer-failed'
  | 'unknown-node';

export class OutputRefError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly field: string,
    public readonly reason: OutputRefErrorReason,
    /** Nearby known node ids for a did-you-mean hint (only used by 'unknown-node'). */
    public readonly candidates: readonly string[] = []
  ) {
    super(OutputRefError.messageFor(nodeId, field, reason, candidates));
    this.name = 'OutputRefError';
  }

  private static messageFor(
    nodeId: string,
    field: string,
    reason: OutputRefErrorReason,
    candidates: readonly string[]
  ): string {
    const ref = `$${nodeId}.output.${field}`;
    switch (reason) {
      case 'not-in-schema':
        return `'${ref}' references field '${field}', which is not declared in node '${nodeId}'s output_format schema. Add '${field}' to the schema (and mark it optional if it can be absent), or fix the reference.`;
      case 'unparseable':
        return `'${ref}' references field '${field}', but node '${nodeId}'s output is not a JSON object, so the field cannot be read. Emit JSON containing '${field}', or reference '$${nodeId}.output' (whole text) instead.`;
      case 'array-aggregate':
        return `'${ref}' references field '${field}', but node '${nodeId}' is a fan-out and its output is a JSON ARRAY of per-child results (each element the child's result value, single-encoded — never a JSON string to parse again), not an object — there is no '${field}' on it and no producer prompt to change, because the array shape is fixed by the engine. Reference '$${nodeId}.output' (the whole array) and read it in a script node, which is also where a failed child's marker ({ archon_failed: true, error, status }) can be handled. See the fan_out docs.`;
      case 'truncated':
        return `'${ref}' references field '${field}', but node '${nodeId}'s persisted output was clipped at the event size cap and no longer parses as JSON. The node very likely emitted '${field}' correctly — this surfaces on a resumed run, which reads the clipped copy rather than the original. Write the payload to a file under $ARTIFACTS_DIR and read it downstream, or shrink the node's output.`;
      case 'missing-key':
        return `'${ref}' references field '${field}', but node '${nodeId}'s JSON output has no such key. Emit '${field}' in the output, or fix the reference.`;
      case 'producer-not-run':
        return `'${ref}' references field '${field}', but node '${nodeId}' did not run (skipped or pending), so it has no output to read. Guard this reference with a 'when:' condition, or fix the dependency.`;
      case 'producer-failed':
        return `'${ref}' references field '${field}', but node '${nodeId}' failed, so its output cannot be trusted. Guard this reference with a 'when:' condition, or fix the failure.`;
      case 'unknown-node': {
        const hint =
          candidates.length > 0
            ? ` Did you mean: ${candidates.map(c => `'${c}'`).join(', ')}?`
            : '';
        return `'${ref}' references node '${nodeId}', but no node with that id has produced output at this point — the id is either unknown (a typo) or belongs to a node that has not run before this reference.${hint} Fix the id, or ensure '${nodeId}' runs first (e.g. add it to depends_on).`;
      }
    }
  }
}

/**
 * Rank known producer ids by proximity to a mistyped node id, for the did-you-mean
 * hint in an 'unknown-node' `OutputRefError`. Returns up to 3 nearest ids (may be
 * empty when nothing is close). Owned here so both substitution seams
 * (`substituteNodeOutputRefs`, condition-evaluator's `resolveOutputRef`) build the
 * error identically.
 */
export function similarNodeIds(nodeId: string, knownIds: Iterable<string>): string[] {
  return findSimilar(nodeId, Array.from(knownIds));
}

/**
 * Property-name set of an `output_format` schema, stored on `NodeOutput.declaredFields`
 * when a producer completes. Returns:
 *   - the property names (possibly `[]` for an explicit empty `properties: {}`) when
 *     the schema declares an object shape — the consumer then enforces the contract;
 *   - `undefined` when there is no schema or it has no `properties` map (a non-object
 *     schema) — the consumer treats such a producer as schemaless.
 */
export function declaredFieldsFromSchema(
  outputFormat: Record<string, unknown> | undefined
): string[] | undefined {
  if (!outputFormat) return undefined;
  const props = outputFormat.properties;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return undefined;
  return Object.keys(props as Record<string, unknown>);
}

/**
 * Distinguish "the producer emitted no JSON" from "the JSON it emitted was clipped
 * before persistence". Same failure to parse, opposite advice to the author: the
 * first means fix the producer, the second means the producer was already right and
 * a resumed run is reading a clipped copy.
 */
function unparseableReason(output: string): OutputRefErrorReason {
  if (hasTruncationMarker(output)) return 'truncated';
  // A fan-out aggregate parses fine — it is simply an array, which `asPlainObject` rejects.
  // Reporting that as 'unparseable' told the author to "emit JSON containing 'x'" from a
  // producer they cannot change, since the engine fixes the array shape. Failing loudly
  // here is correct (a failed slot's { archon_failed, error, status } marker must never
  // be consumed as data); only the advice was wrong.
  try {
    if (Array.isArray(JSON.parse(output) as unknown)) return 'array-aggregate';
  } catch {
    // fall through — genuinely unparseable
  }
  return 'unparseable';
}

export type FieldResolution = { kind: 'value'; value: unknown } | { kind: 'empty' };

/** Strip a single markdown code fence (```json … ```) some models/scripts wrap JSON in. */
const FENCE_RE = /^[\s\S]*?```(?:json)?\s*\n([\s\S]*?)\n\s*```[\s\S]*$/;

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseOutputObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  let candidate = text;
  const fenceMatch = FENCE_RE.exec(candidate);
  if (fenceMatch?.[1]) candidate = fenceMatch[1];
  try {
    return asPlainObject(JSON.parse(candidate));
  } catch {
    return undefined;
  }
}

/**
 * Resolve `field` against a producer's `NodeOutput`. Returns the raw field value
 * (callers stringify per their context), signals an intended empty, or throws
 * `OutputRefError` for the strict cases. See the module doc for the full table.
 */
export function resolveNodeOutputField(
  nodeOutput: NodeOutput,
  nodeId: string,
  field: string
): FieldResolution {
  // A producer that did not run (skipped) or has not settled (pending) has no
  // output to read a field from. Surface that directly rather than letting it
  // fall through to the schemaless path and throw the misleading "not a JSON
  // object" error on its empty output.
  if (nodeOutput.state === 'skipped' || nodeOutput.state === 'pending') {
    throw new OutputRefError(nodeId, field, 'producer-not-run');
  }

  // A failed producer never resolves a field, however JSON-shaped its leftover
  // output looks (#2713): a loop_group's failure paths carry the last completed
  // iteration's real, often-valid-JSON text, which would otherwise be read here
  // as if the group had succeeded — the same class of bug #2696/#2710 fixed for
  // the `{ from, if_skipped }` binding directive.
  if (nodeOutput.state === 'failed') {
    throw new OutputRefError(nodeId, field, 'producer-failed');
  }

  const declaredFields = 'declaredFields' in nodeOutput ? nodeOutput.declaredFields : undefined;
  const structured = 'structuredOutput' in nodeOutput ? nodeOutput.structuredOutput : undefined;
  const structuredObj = asPlainObject(structured);

  // 1. Declared-schema producer — the declared property set IS the contract.
  if (declaredFields !== undefined) {
    if (!declaredFields.includes(field)) {
      throw new OutputRefError(nodeId, field, 'not-in-schema');
    }
    // Prefer the parsed payload; fall back to parsing the JSON-serialized output.
    // The fallback covers older NodeOutput rows that predate `structuredOutput`,
    // and resumes of runs persisted before `structured_output` rode along in
    // `node_completed` events (#2637) — current resumes rehydrate the payload.
    const obj = structuredObj ?? parseOutputObject(nodeOutput.output);
    // No parseable object AT ALL is not a declared-optional field — it is a producer
    // that did not honour its schema, and it must fail exactly as loudly as the
    // schemaless path below (#2456). Returning empty here made declaring
    // `output_format` QUIETER than declaring nothing, which is backwards: a
    // `workflow:` node's output_format is never validated against the child (it only
    // populates declaredFields), so every declared field silently became ''.
    if (obj === undefined) {
      throw new OutputRefError(nodeId, field, unparseableReason(nodeOutput.output));
    }
    const value = obj[field];
    // Required fields are guaranteed present (the producer validated post-parse),
    // so a missing/explicit-null value here is a declared-optional field → empty.
    if (value === undefined || value === null) return { kind: 'empty' };
    return { kind: 'value', value };
  }

  // 2. Structured payload without a declared schema (legacy rows / non-object
  //    schema): prefer it, but stay lenient — with no schema we cannot tell an
  //    optional-absent field from a typo, so an absent field is '' (not a throw).
  //    A present null value is kept (callers stringify it to "null"), matching
  //    the historical structuredOutput-preference behavior.
  if (structuredObj !== undefined) {
    const value = structuredObj[field];
    if (value === undefined) return { kind: 'empty' };
    return { kind: 'value', value };
  }

  // 3. Schemaless producer (bash/script/prose). The author wrote `.field`, so
  //    JSON carrying that key is expected; anything else is a drop they must see.
  const obj = parseOutputObject(nodeOutput.output);
  if (obj === undefined) {
    throw new OutputRefError(nodeId, field, unparseableReason(nodeOutput.output));
  }
  if (!(field in obj)) throw new OutputRefError(nodeId, field, 'missing-key');
  return { kind: 'value', value: obj[field] };
}

/**
 * Guard the whole-text `$node.output` form against a failed producer's stale output
 * (#2696/#2710/#2713): a `loop_group`'s failure paths carry the last completed
 * iteration's real, often-valid-JSON output text, which must never be read as if the
 * producer had succeeded. Mirrors the `state === 'failed'` guard already built into
 * `resolveNodeOutputField` above for the fielded form, so every whole-text reader
 * routes through this one function instead of repeating the check (#2722), replacing
 * the KEEP-IN-SYNC enumeration this module doc used to carry. This is a runtime check,
 * not a type-level one — nothing stops a future caller from reading `nodeOutput.output`
 * directly without calling this function first; the value is having one place to route
 * through, not a compiler-enforced guarantee against bypass.
 *
 * `buildMessage` lets each caller keep its own wording — a binding directive names
 * `if_skipped`, a `when:` guard names the condition, and so on — only the
 * check-and-throw mechanism is shared.
 */
export function assertProducerNotFailed(
  nodeOutput: NodeOutput,
  buildMessage: (failed: Extract<NodeOutput, { state: 'failed' }>) => string
): void {
  if (nodeOutput.state === 'failed') {
    throw new Error(buildMessage(nodeOutput));
  }
}
