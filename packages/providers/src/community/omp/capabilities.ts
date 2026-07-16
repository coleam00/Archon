import type { ProviderCapabilities } from '../../types';

/**
 * Oh My Pi capabilities. Flags describe behavior actually wired by the Archon
 * adapter, not everything OMP could support in standalone CLI mode.
 */
export const OMP_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: true,
  structuredOutput: 'best-effort',
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: false,
  nativeTools: true,
};
