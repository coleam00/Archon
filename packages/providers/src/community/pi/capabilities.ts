import type { ProviderCapabilities } from '../../types';

/**
 * Pi capabilities — intentionally conservative. Declared flags must reflect
 * wired-up behavior, not potential support. The dag-executor uses these to
 * warn users when a workflow node specifies a feature the provider ignores.
 *
 * envInjection covers both auth-key passthrough (setRuntimeApiKey for mapped
 * provider env vars) and bash tool subprocess env (BashSpawnHook merges the
 * caller's env over Pi's inherited baseline), matching Claude/Codex semantics.
 */
export const PI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: true,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
