/**
 * Model compatibility check for the Copilot provider.
 *
 * Copilot accepts a wide variety of models (OpenAI, Anthropic, Gemini, BYOK)
 * and there's no authoritative catalog to validate against. But some names
 * unambiguously DO NOT belong to Copilot — the Claude aliases and the
 * `'inherit'` sentinel. Excluding them here catches config mistakes at
 * workflow validation time instead of letting them reach the SDK with a
 * confusing runtime error.
 *
 * Since Copilot is a community provider, `inferProviderFromModel` (in the
 * workflows package) does NOT walk it — this fn only runs when the user
 * explicitly names `provider: copilot` in their workflow or config. So the
 * bar is "fail loud on config mistakes", not "match an authoritative
 * catalog".
 */
const CLAUDE_ALIASES = new Set<string>(['sonnet', 'opus', 'haiku']);

export function isCopilotModelCompatible(model: string): boolean {
  if (typeof model !== 'string') return false;
  if (CLAUDE_ALIASES.has(model)) return false;
  if (model === 'inherit') return false;
  if (model.trim() === '') return false;
  // Copilot does serve Anthropic via BYOK with names like `claude-sonnet-4.5`,
  // so don't blanket-reject the `claude-` prefix.
  return true;
}
