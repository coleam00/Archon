import type { ProviderCapabilities } from '../../types';

/**
 * Copilot capabilities — intentionally conservative. Flipping a flag to `true`
 * means the dag-executor will NOT warn when a workflow node specifies that
 * feature; keep each flag honest by only declaring what's wired in `provider.ts`
 * and `event-bridge.ts`.
 *
 * `effortControl` + `thinkingControl` are both true because Copilot's
 * `reasoningEffort` gates both the model's reasoning budget and the
 * `assistant.reasoning_delta` event stream — one SDK axis that covers both
 * Archon concepts.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
