import type { ProviderCapabilities } from '../../types';

/**
 * Copilot capabilities — each flag declares behavior that is wired end-to-end
 * through `provider.ts` (translation + SDK integration) and `event-bridge.ts`
 * (streaming). Flipping a flag to `true` suppresses the dag-executor's
 * per-capability warning, so keep each flag honest.
 *
 * `effortControl` is true because Copilot's `reasoningEffort` gates the
 * model's reasoning budget.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'best-effort', // prompt-augment + repair + validate + reask×3 (no SDK grammar)
  envInjection: true,
  costControl: false,
  effortControl: true,
  fallbackModel: false,
  sandbox: false,
  settingSources: false, // Claude Agent SDK-only knob (which setting sources the agent loads)
  nativeTools: false,
  containerExec: false, // no in-container spawn path yet (fail-fast source of truth)
};
