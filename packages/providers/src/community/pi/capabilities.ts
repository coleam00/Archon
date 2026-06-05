import type { ProviderCapabilities } from '../../types';

/**
 * Pi capabilities — intentionally conservative. Declared flags must reflect
 * wired-up behavior, not potential support. The dag-executor uses these to
 * warn users when a workflow node specifies a feature the provider ignores.
 *
 * envInjection covers both auth-key passthrough (setRuntimeApiKey for mapped
 * provider env vars) and bash tool subprocess env (BashSpawnHook merges the
 * caller's env over Pi's inherited baseline), matching Claude/Codex semantics.
 *
 * structuredOutput is best-effort (not SDK-enforced like Claude/Codex): the
 * provider appends a "JSON only" instruction + the schema to the prompt and
 * the event bridge parses the final assistant transcript on agent_end.
 * Reliable on instruction-following models (GPT-5, Claude, Gemini 2.x,
 * recent Qwen Coder, DeepSeek V3); the dag-executor validates the parsed output
 * against the schema and FAILS the node on a miss/invalid (a bounded reask loop
 * is planned for PR 2).
 */
export const PI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: true,
  structuredOutput: 'best-effort', // prompt-augment + repair + validate (no SDK grammar; reask = PR 2)
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
  nativeTools: true,
};
