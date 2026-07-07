import type { ProviderCapabilities } from '../../types';

/**
 * Qoder CLI capabilities that are wired through this provider.
 * Keep false for features qodercli may support but this provider does not translate yet.
 */
export const QODERCLI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: 'best-effort',
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
  nativeTools: false,
};
