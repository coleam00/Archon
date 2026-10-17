import { jsonrepair } from 'jsonrepair';
import { isObjectSchemaNode } from '@archon/provider-contract';

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
