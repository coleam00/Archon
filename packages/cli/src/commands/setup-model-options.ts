export const DEFAULT_CHAT_MODEL_OPTIONS: Record<string, { value: string; hint?: string }[]> = {
  claude: [
    { value: 'sonnet', hint: 'balanced (SDK default)' },
    { value: 'opus', hint: 'most capable' },
    { value: 'haiku', hint: 'fastest' },
  ],
  codex: [{ value: 'gpt-5.6-sol' }, { value: 'gpt-5.6-terra' }, { value: 'gpt-5.6-luna' }],
};
