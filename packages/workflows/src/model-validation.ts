export function isClaudeModel(model: string): boolean {
  return (
    model === 'sonnet' ||
    model === 'opus' ||
    model === 'haiku' ||
    model === 'inherit' ||
    model.startsWith('claude-')
  );
}

export function isPiModel(model: string): boolean {
  return model.startsWith('pi:');
}

/**
 * Infer provider from a model name. Returns 'claude' if the model matches
 * Claude naming patterns, 'pi' if it starts with 'pi:', 'codex' otherwise.
 *
 * When no model is provided, returns the default provider.
 */
export function inferProviderFromModel(
  model: string | undefined,
  defaultProvider: 'claude' | 'codex' | 'pi'
): 'claude' | 'codex' | 'pi' {
  if (!model) return defaultProvider;
  if (isClaudeModel(model)) return 'claude';
  if (isPiModel(model)) return 'pi';
  return 'codex';
}

export function isModelCompatible(provider: 'claude' | 'codex' | 'pi', model?: string): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  if (provider === 'pi') return isPiModel(model);
  // Codex: accept most models, but reject obvious Claude aliases/prefixes and Pi models
  return !isClaudeModel(model) && !isPiModel(model);
}
