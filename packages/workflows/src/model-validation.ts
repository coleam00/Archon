/**
 * Model validation utilities for provider/model compatibility checks.
 *
 * Used by the workflow loader (loader.ts) and DAG executor (dag-executor.ts) to
 * reject invalid provider/model combinations at load time rather than at runtime.
 */

/**
 * Returns true if the given model string is a Claude-specific alias or prefix.
 *
 * Recognized Claude identifiers: `sonnet`, `opus`, `haiku`, `inherit`, or any
 * string starting with `claude-`. Everything else is treated as non-Claude.
 */
export function isClaudeModel(model: string): boolean {
  return (
    model === 'sonnet' ||
    model === 'opus' ||
    model === 'haiku' ||
    model === 'inherit' ||
    model.startsWith('claude-')
  );
}

/**
 * Returns true if the given model string is compatible with the specified provider.
 *
 * Rules:
 * - If `model` is undefined, any provider accepts it (inherit from config defaults).
 * - Claude provider: accepts only Claude aliases/prefixes (see `isClaudeModel`).
 * - Ollama provider: accepts any model string (Ollama model names are arbitrary).
 * - Codex provider: accepts any model that is NOT a Claude alias/prefix.
 */
export function isModelCompatible(
  provider: 'claude' | 'codex' | 'ollama',
  model?: string
): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  if (provider === 'ollama') return true; // Any model string is valid for Ollama
  // Codex: accept most models, but reject obvious Claude aliases/prefixes
  return !isClaudeModel(model);
}
