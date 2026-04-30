import type { ProviderCapabilities } from '../../types';

/**
 * Oh My Pi capabilities. Flags describe behavior actually wired by the Archon
 * adapter, not everything OMP could support in standalone CLI mode.
 */
export const OMP_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: false,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
