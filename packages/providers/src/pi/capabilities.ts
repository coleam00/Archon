import type { ProviderCapabilities } from '../types';

export const PI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
