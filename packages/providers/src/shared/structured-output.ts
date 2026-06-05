/**
 * Shared structured-output helpers.
 *
 * Best-effort providers (Pi/Copilot) have no native JSON-mode equivalent to
 * Claude's `outputFormat` or Codex's `outputSchema`, so they use a two-step
 * approach:
 *   1. Augment the user prompt with a "respond with JSON matching this schema"
 *      instruction, so instruction-following models emit parseable JSON.
 *   2. After the run completes, parse the accumulated assistant transcript
 *      (`tryParseStructuredOutput`).
 *
 * When parsing fails it returns `undefined`. The dag-executor treats a node that
 * declared `output_format` but produced no parseable structured output as a
 * FAILED node (fail-fast) — it no longer degrades silently to a warning. (A
 * bounded validate-and-reask loop for best-effort providers lands in PR 2; until
 * then both tiers fail fast.)
 *
 * This module also owns the cross-provider validation layer the dag-executor
 * runs for EVERY provider (enforced and best-effort): `validateStructuredOutput()`
 * checks a parsed value against the node's declared JSON Schema (ajv), and
 * `formatSchemaErrors()` renders the failures for logs (and PR 2's reask prompts).
 */
// Direct `ajv` / `jsonrepair` imports (not via @hono/zod-openapi): @archon/providers
// is an SDK-deps-only leaf package that must not pull in Hono. Precedent: the
// direct `zod` import in claude/native-tools.ts (see CLAUDE.md Zod conventions).
// ajv MUST resolve to ^8 — a transitive ajv@6 exists in the tree with a different
// API/draft; the package.json `^8` dep pins it per package.
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { jsonrepair } from 'jsonrepair';

/**
 * Append a "respond with JSON matching this schema" instruction to the user
 * prompt. Same wording originally authored for Pi — reused verbatim so
 * prompt drift across providers is zero.
 */
export function augmentPromptForJsonSchema(
  prompt: string,
  schema: Record<string, unknown>
): string {
  return `${prompt}

---

CRITICAL: Respond with ONLY a JSON object matching the schema below. No prose before or after the JSON. No markdown code fences. Just the raw JSON object as your final message.

Schema:
${JSON.stringify(schema, null, 2)}`;
}

/**
 * Attempt to parse an assistant transcript as the structured-output JSON object.
 * Handles four common model failure modes, in tiers:
 *  - trailing/leading whitespace (always stripped)
 *  - markdown code fences (```json ... ``` or bare ``` ... ```) that models
 *    emit despite the "no code fences" instruction in the prompt
 *  - prose preamble followed by a single trailing JSON object — pattern
 *    observed on Minimax M2.7 reasoning models that "think out loud" before
 *    emitting structured output despite explicit JSON-only prompts
 *  - structural corruption (trailing commas, single quotes, unquoted keys, a
 *    `max_tokens`-truncated tail) repaired via jsonrepair (tier 3)
 *
 * The contract is a JSON OBJECT: top-level arrays/primitives return `undefined`
 * (the augmentation always asks for an object, and `output_format` is an object
 * schema). Returns the parsed object on success, `undefined` on any failure.
 * `undefined` means "structured output unavailable" — for a node that declared
 * `output_format`, the dag-executor fails the node (fail-fast), it does not
 * silently degrade.
 */
export function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Strip ```json / ``` fences if present. Match only at boundaries so we
  // don't mangle JSON strings that legitimately contain backticks.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  // Tier 1: clean parse — fast path for fully compliant outputs.
  const tier1 = tryJsonParseObject(cleaned);
  if (tier1 !== undefined) return tier1;

  // Tier 2: scan forward to the FIRST `{` and parse from there. Recovers the
  // preamble-then-JSON pattern reasoning models emit. A backward scan from
  // the last `{` was considered but rejected: it silently returns the wrong
  // object when the prose contains a brace-bearing example after the real
  // payload (e.g. `{"actual":1}\nFor example: {"x":2}` would yield `{x:2}`),
  // breaking the conservative-failure contract callers rely on.
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) {
    const tier2 = tryJsonParseObject(cleaned.slice(firstBrace));
    if (tier2 !== undefined) return tier2;
  }

  // Tier 3: structural repair (jsonrepair) of the object region. Fixes the
  // failure modes the earlier tiers can't — trailing commas, single quotes,
  // unquoted keys, and the truncated tail of a `max_tokens`-cut response,
  // including a prose preamble before the object.
  //
  // Gated to a slice that starts at the first `{` AND contains a `:` (i.e.
  // something shaped like a key/value object). jsonrepair is aggressive enough
  // to turn comma-separated prose into an array and `{not valid` into
  // `{"not valid":null}`; the gate keeps that garbage out so the
  // conservative-failure contract holds (prose / brace-without-colon →
  // undefined). jsonrepair also throws on irreparable input, which we swallow.
  if (firstBrace >= 0) {
    const region = cleaned.slice(firstBrace);
    if (region.includes(':')) {
      try {
        // tryJsonParseObject is object-only, which matters most here: jsonrepair
        // turns `{valid}\ntrailing prose` into the array `[{valid}, "…"]`, and
        // rejecting non-objects keeps that bogus data out (degrade cleanly).
        const tier3 = tryJsonParseObject(jsonrepair(region));
        if (tier3 !== undefined) return tier3;
      } catch {
        /* irreparable — fall through to the undefined contract */
      }
    }
  }

  return undefined;
}

/**
 * Parse `text` as JSON and only return it if the result is a non-null, non-array
 * object. Schema augmentation always asks for an object and `output_format` is an
 * object schema — bare `null`, numbers, strings, AND top-level arrays parse
 * cleanly but are not valid structured output, so all of them are treated as
 * missing (returns `undefined`). Object-only across every tier keeps the contract
 * consistent and stops jsonrepair's prose→array coercion from leaking through.
 */
function tryJsonParseObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * True when `node`'s shape marks it as a JSON-Schema object node: it declares
 * `type: 'object'` (or a type union including `'object'`) or carries a
 * `properties` map. OpenAI strict-mode requires `additionalProperties: false`
 * on exactly these nodes.
 */
function isObjectSchemaNode(node: Record<string, unknown>): boolean {
  const typeIncludesObject =
    node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
  return typeIncludesObject || 'properties' in node;
}

/**
 * Recursively inject `additionalProperties: false` on every object schema so a
 * JSON Schema satisfies OpenAI's Structured Outputs strict-mode validator.
 *
 * OpenAI rejects any `object` node that does not declare `additionalProperties:
 * false` (HTTP 400 invalid_json_schema). Claude and most other providers don't
 * require this, so workflow authors write portable `output_format` schemas and
 * the Codex provider adapts them here. Returns a deep clone — the caller's
 * schema object is never mutated.
 *
 * A pre-existing `additionalProperties` on an object — including a value
 * subschema like `additionalProperties: { type: 'string' }` (an open record /
 * map) — is replaced with `false`. OpenAI strict-mode forbids open or typed
 * additional properties, so `false` is the only value the API accepts; keeping
 * the subschema would just re-trigger the HTTP 400 this normalizer exists to fix.
 * Callers that want to warn the author before silently dropping those semantics
 * can detect the case up front with {@link hasOpenAdditionalProperties}.
 *
 * Scope: only `additionalProperties` is injected. The other strict-mode rule
 * (every key in `properties` must appear in `required`) is intentionally NOT
 * enforced here — forcing it would silently turn optional fields into required
 * ones. See issue #1843.
 */
export function normalizeJsonSchemaForOpenAiStrict(
  schema: Record<string, unknown>
): Record<string, unknown> {
  return normalizeNode(schema) as Record<string, unknown>;
}

/**
 * Recursive worker for {@link normalizeJsonSchemaForOpenAiStrict}. Walks any
 * JSON value (object, array, or scalar); only object nodes are closed. Kept
 * private so the public entry point can express the real `Record → Record`
 * contract while recursion still descends into arrays and scalars.
 */
function normalizeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeNode);
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    result[key] = normalizeNode(value);
  }
  if (isObjectSchemaNode(result)) {
    result.additionalProperties = false;
  }

  return result;
}

/**
 * True if any object node in `schema` declares `additionalProperties` as
 * something other than `false` — e.g. `additionalProperties: true` or an
 * open-record subschema like `additionalProperties: { type: 'string' }`.
 * {@link normalizeJsonSchemaForOpenAiStrict} silently rewrites these to `false`
 * for OpenAI strict-mode; the Codex provider uses this to warn the author that
 * their open-record semantics were dropped. Detection reuses the normalizer's
 * object-node rule, so it never flags a node the normalizer would leave
 * untouched. See issue #1843.
 */
export function hasOpenAdditionalProperties(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some(hasOpenAdditionalProperties);
  }
  if (schema === null || typeof schema !== 'object') {
    return false;
  }
  const node = schema as Record<string, unknown>;
  if (
    isObjectSchemaNode(node) &&
    'additionalProperties' in node &&
    node.additionalProperties !== false
  ) {
    return true;
  }
  return Object.values(node).some(hasOpenAdditionalProperties);
}

// ─── Schema validation (ajv) ─────────────────────────────────────────────────

/**
 * Single process-wide ajv instance. `strict: false` keeps it tolerant of the
 * dialect drift real author schemas carry (unknown keywords/formats are ignored
 * rather than throwing at compile time); `allErrors: true` surfaces every
 * failure at once so a reask prompt can list them all.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compiled-validator cache keyed by the schema object identity. Compilation is
 * the cost (validation is cheap), and the dag-executor passes the same
 * `node.output_format` object across a node's lifetime (including every reask
 * attempt), so a WeakMap keyed by reference is a free hit without holding the
 * schema alive past its node.
 */
const validatorCache = new WeakMap<object, ValidateFunction>();

/**
 * Discriminated so the `errors` array only exists on the failure branch — the
 * caller can't read errors off a valid result, and a valid result can't smuggle
 * a non-empty errors list.
 */
export type StructuredValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Validate a parsed structured-output value against the node's declared JSON
 * Schema. Used for EVERY provider that declares `output_format` — even
 * SDK-enforced ones (Claude/Codex/OpenCode) need this net for the refusal /
 * `max_tokens`-truncation edges that bypass grammar-constrained decoding.
 *
 * The author's schema is validated as written — `additionalProperties` is NOT
 * required (that is an OpenAI-strict-mode concern handled separately by the
 * Codex normalizer), and optional fields stay optional.
 *
 * Fail-SAFE on a schema that ajv cannot compile (exotic dialect, bad `$ref`):
 * returns `{ valid: true }` so an un-compilable schema never turns a
 * genuinely-correct provider response into a spurious node failure. The compile
 * error is handed to the caller via the `onCompileError` hook, which the
 * dag-executor uses to both log AND surface a user-facing warning (so a schema
 * that silently can't be enforced doesn't go unnoticed).
 */
export function validateStructuredOutput(
  value: unknown,
  schema: Record<string, unknown>,
  onCompileError?: (message: string) => void
): StructuredValidationResult {
  let validate = validatorCache.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
      validatorCache.set(schema, validate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onCompileError?.(message);
      // Can't validate → don't block. The net only covers compilable schemas.
      return { valid: true };
    }
  }

  if (validate(value)) return { valid: true };
  return { valid: false, errors: formatSchemaErrors(validate.errors) };
}

/**
 * Render ajv errors as `path: message` lines for reask prompts and logs.
 * `instancePath` is empty for a root-level failure (e.g. a missing top-level
 * required field), rendered as `(root)`. Returns a single generic line when ajv
 * reports a failure with no error detail (shouldn't happen with `allErrors`).
 */
export function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ['value does not match the declared schema'];
  }
  return errors.map(e => {
    const path = e.instancePath && e.instancePath.length > 0 ? e.instancePath : '(root)';
    const detail = e.params?.missingProperty
      ? `${e.message} ('${String(e.params.missingProperty)}')`
      : (e.message ?? 'invalid');
    return `${path}: ${detail}`;
  });
}
