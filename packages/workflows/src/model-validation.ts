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
  defaultProvider: 'claude' | 'codex'
): 'claude' | 'codex' {
  if (!model) return defaultProvider;
  if (isClaudeModel(model)) return 'claude';
  return 'codex';
}

export function isModelCompatible(provider: 'claude' | 'codex', model?: string): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  // Codex: accept most models, but reject obvious Claude aliases/prefixes
  return !isClaudeModel(model);
}
