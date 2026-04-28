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
 * Handles two common model failure modes:
 *  - trailing/leading whitespace (always stripped)
 *  - markdown code fences (```json ... ``` or bare ``` ... ```) that models
 *    emit despite the "no code fences" instruction in the prompt
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
  try {
    const parsed: unknown = JSON.parse(cleaned);
    // Schema augmentation always asks for an object — bare `null`, numbers,
    // and strings are valid JSON but not "structured output". Treat them as
    // missing so the dag-executor's structured_output_missing path engages.
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
