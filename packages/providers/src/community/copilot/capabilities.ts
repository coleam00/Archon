import type { ProviderCapabilities } from '../../types';

/**
 * Copilot capabilities are intentionally conservative.
 *
 * The SDK can do more than this provider currently exposes, but the flags here
 * only describe behavior that is wired to Archon's existing workflow surface.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
