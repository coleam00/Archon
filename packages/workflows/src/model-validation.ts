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
  defaultProvider: 'claude' | 'codex' | 'copilot'
): 'claude' | 'codex' | 'copilot' {
  if (!model) return defaultProvider;
  if (isClaudeModel(model)) return 'claude';
  return defaultProvider;
}

export function isModelCompatible(
  provider: 'claude' | 'codex' | 'copilot',
  model?: string
): boolean {
  // Validate provider is one of the allowed values
  if (!['claude', 'codex', 'copilot'].includes(provider)) {
    throw new Error(`Unknown provider '${provider}'`);
  }
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  if (provider === 'copilot') return true;
  return !isClaudeModel(model);
}
