/**
 * Shape of a parsed Pi model reference.
 * Pi's catalog is large and fast-moving, so Archon does syntactic validation
 * only at registration time and defers catalog lookup to `getModel()` at
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
  const value = raw.trim();
  const idx = value.indexOf('/');
  if (idx <= 0 || idx === value.length - 1) return undefined;

  const provider = value.slice(0, idx).trim();
  const modelId = value.slice(idx + 1).trim();

  if (!/^[a-z][a-z0-9-]*$/.test(provider)) return undefined;
  if (modelId.length === 0) return undefined;

  return { provider, modelId };
}
