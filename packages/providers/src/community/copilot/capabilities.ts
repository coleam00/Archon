import type { ProviderCapabilities } from '../../types';

/**
 * Copilot capabilities — each flag declares behavior that is wired end-to-end
 * through `provider.ts` (translation + SDK integration) and `event-bridge.ts`
 * (streaming). Flipping a flag to `true` suppresses the dag-executor's
 * per-capability warning, so keep each flag honest.
 *
 * `effortControl` + `thinkingControl` are both true because Copilot's
 * `reasoningEffort` gates both the model's reasoning budget and the
 * `assistant.reasoning_delta` event stream — one SDK axis that covers both
 * Archon concepts.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
