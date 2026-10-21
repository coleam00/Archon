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
 * node's schema becomes a terminating `structured_output` tool whose arguments
 * are the output, with the reply text parsed as the fallback. It stays
 * best-effort because Pi's agent session cannot force a tool call (`toolChoice`
 * is not reachable from it), so a model can still answer in prose or not at
 * all. The dag-executor validates the output against the schema, re-asks up to
 * 3× on a miss/invalid, then FAILS the node.
 */
export const PI_CAPABILITIES: ProviderCapabilities = {
  backgroundWork: 'none',
  sessionResume: true,
  sessionFork: true,
  mcp: false,
  hooks: false,
  skills: true,
  plugins: false, // Pi has no plugins; its extensions are user-owned configuration
  agents: false,
  toolRestrictions: true,
  structuredOutput: 'best-effort', // terminating tool call, unforceable; text fallback + reask×3
  requiresAllPropertiesRequired: false, // best-effort providers never reject schemas at API level
  envInjection: true,
  costControl: false, // no maxBudgetUsd translation — the executor warns and drops it
  costReporting: true, // event-bridge maps usage.cost.total — uncappable, but every turn is priced
  tokenReporting: true,
  stopReasonReporting: true,
  turnCountReporting: false,
  resolvedModelReporting: true,
  effortControl: true,
  fallbackModel: false,
  sandbox: false,
  settingSources: false, // Claude Agent SDK-only knob (which setting sources the agent loads)
  nativeTools: true,
  containerExec: false, // no in-container spawn path yet (fail-fast source of truth)
};
