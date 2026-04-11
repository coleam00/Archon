export const ASSISTANT_PROVIDER_VALUES = ['claude', 'codex', 'qwen'] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDER_VALUES)[number];

export function isClaudeModel(model: string): boolean {
  return (
    model === 'sonnet' ||
    model === 'opus' ||
    model === 'haiku' ||
    model === 'inherit' ||
    model.startsWith('claude-')
  );
}

export function isQwenModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.startsWith('qwen') ||
    normalized.startsWith('qwq') ||
    normalized.startsWith('qvq') ||
    normalized.endsWith('-coder-model') ||
    normalized === 'coder-model' ||
    normalized.includes('qwen-coder') ||
    normalized.includes('qwen-max') ||
    normalized.includes('qwen-turbo') ||
    normalized.includes('qwen-plus')
  );
}

export function inferProviderFromModel(model?: string): AssistantProvider | undefined {
  if (!model) return undefined;
  if (isClaudeModel(model)) return 'claude';
  if (isQwenModel(model)) return 'qwen';
  return undefined;
}

export function isModelCompatible(provider: AssistantProvider, model?: string): boolean {
  if (!model) return true;
  if (provider === 'claude') return isClaudeModel(model);
  if (provider === 'qwen') return isQwenModel(model);
  // Codex: accept most models, but reject obvious Claude/Qwen aliases/prefixes
  return !isClaudeModel(model) && !isQwenModel(model);
}
