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
 * Infer provider from a model name. Returns 'claude' if the model matches
 * Claude naming patterns, 'codex' otherwise.
 *
 * When no model is provided, returns the default provider.
 *
 * Phase 2 will replace this with a registry-driven lookup that iterates
 * built-in provider registrations.
 */
export function inferProviderFromModel(
  model: string | undefined,
  defaultProvider: 'claude' | 'codex' | 'ollama'
): 'claude' | 'codex' | 'ollama' {
  if (!model) return defaultProvider;
  if (isClaudeModel(model)) return 'claude';
  return 'codex';
}

/**
 * Returns true if the given model string is compatible with the specified provider.
 *
 * Rules:
 * - If `model` is undefined, any provider accepts it (inherit from config defaults).
 * - Claude provider: accepts only Claude aliases/prefixes (see `isClaudeModel`).
 * - Ollama provider: accepts any model string except `'inherit'`, which is a Claude-only sentinel.
 * - Codex provider: accepts any model that is NOT a Claude alias/prefix.
 */
export function isModelCompatible(
  provider: 'claude' | 'codex' | 'ollama',
  model?: string
): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  if (provider === 'ollama') return model !== 'inherit'; // 'inherit' is a Claude-only sentinel
  // Codex: accept most models, but reject obvious Claude aliases/prefixes
  return !isClaudeModel(model);
}
