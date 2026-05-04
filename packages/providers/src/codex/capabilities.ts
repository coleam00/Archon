import type { ProviderCapabilities } from '../types';

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
