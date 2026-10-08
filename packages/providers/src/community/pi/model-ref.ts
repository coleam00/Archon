import { z } from 'zod';

export const piModelRefSchema = z
  .string()
  .regex(
    /^\s*[a-z][a-z0-9-]*\s*\/\s*\S[\s\S]*$/,
    "expected a Pi vendor/model reference such as 'minimax/minimax-m3'"
  );

/**
 * Shape of a parsed Pi model reference.
 * Pi's catalog is large and fast-moving, so Archon does syntactic validation
 * when reading config and defers catalog lookup to the SDK at
 * query time.
 */
export interface PiModelRef {
  /** Pi provider id, e.g. 'google', 'anthropic', 'openai', 'groq', 'openrouter'. */
  provider: string;
  /** Model id (may itself contain slashes, e.g. 'qwen/qwen3-coder' under openrouter). */
  modelId: string;
}

/**
 * Parse a Pi model ref. Splits on the FIRST '/' so that namespaced model ids
 * under providers like OpenRouter work:
 *   'openrouter/qwen/qwen3-coder' → { provider: 'openrouter', modelId: 'qwen/qwen3-coder' }
 *
 * Returns undefined for malformed refs so callers can surface clear errors.
 */
export function parsePiModelRef(raw: string): PiModelRef | undefined {
  if (!piModelRefSchema.safeParse(raw).success) return undefined;
  const value = raw.trim();
  const idx = value.indexOf('/');

  const provider = value.slice(0, idx).trim();
  const modelId = value.slice(idx + 1).trim();

  return { provider, modelId };
}
