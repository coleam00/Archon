/**
 * Shared best-effort structured-output helpers for providers that have no
 * native JSON-mode equivalent to Claude's `outputFormat` or Codex's
 * `outputSchema`. The approach is two-step:
 *
 *   1. Augment the user prompt with a "respond with JSON matching this schema"
 *      instruction, so instruction-following models emit parseable JSON.
 *   2. After the run completes, parse the accumulated assistant transcript.
 *
 * Models that reliably follow instruction (GPT-5, Claude, Gemini 2.x, recent
 * Qwen Coder, DeepSeek V3) return clean JSON; models that don't produce a
 * parse failure, which the executor surfaces via the existing
 * `dag.structured_output_missing` warning.
 */

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
 * Attempt to parse an assistant transcript as the structured-output JSON.
 * Handles three common model failure modes:
 *  - trailing/leading whitespace (always stripped)
 *  - markdown code fences (```json ... ``` or bare ``` ... ```) that models
 *    emit despite the "no code fences" instruction in the prompt
 *  - prose preamble followed by a single trailing JSON object — pattern
 *    observed on Minimax M2.7 reasoning models that "think out loud" before
 *    emitting structured output despite explicit JSON-only prompts.
 *
 * Returns the parsed value on success, `undefined` on any failure. Callers
 * treat `undefined` as "structured output unavailable" and degrade via the
 * dag-executor's existing missing-structured-output warning.
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

  return undefined;
}

/**
 * Parse `text` as JSON and only return it if the result is a non-null
 * object (or array). Schema augmentation always asks for an object — bare
 * `null`, numbers, and strings parse cleanly but are not "structured
 * output", so we treat them as missing and let the dag-executor's
 * structured_output_missing path engage.
 */
function tryJsonParseObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return undefined;
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
