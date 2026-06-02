/**
 * Shape of a parsed OMP model reference.
 * OMP's model registry supports provider/modelId format, same as Pi.
 */
export interface OmpModelRef {
  /** OMP provider id, e.g. 'anthropic', 'openai', 'google', 'groq', 'openrouter'. */
  provider: string;
  /** Model id (may contain slashes, e.g. 'qwen/qwen3-coder' under openrouter). */
  modelId: string;
}

/**
 * Parse an OMP model ref. Splits on the FIRST '/' so namespaced model ids
 * under providers like OpenRouter work correctly:
 *   'openrouter/qwen/qwen3-coder' → { provider: 'openrouter', modelId: 'qwen/qwen3-coder' }
 *
 * Returns undefined for malformed refs so callers can surface clear errors.
 */
export function parseOmpModelRef(raw: string | undefined): OmpModelRef | undefined {
  if (!raw) return undefined;
  const idx = raw.indexOf('/');
  if (idx <= 0 || idx === raw.length - 1) return undefined;

  const provider = raw.slice(0, idx);
  const modelId = raw.slice(idx + 1);

  if (!/^[a-z][a-z0-9-]*$/.test(provider)) return undefined;
  if (modelId.length === 0) return undefined;

  return { provider, modelId };
}
