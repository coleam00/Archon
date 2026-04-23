import type { ProviderCapabilities } from '../../types';

/**
 * OpenCode SDK capabilities — reflects actual SDK features only.
 * The dag-executor uses these to warn users when a workflow node
 * specifies a feature the provider ignores.
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: false,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
