import type { ProviderCapabilities } from '../../types';

export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
