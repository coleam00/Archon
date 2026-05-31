import type { ProviderCapabilities } from '../../types';

/**
 * Cursor capabilities — each flag must reflect wired behavior in `provider.ts`
 * and `event-bridge.ts`. The dag-executor warns when nodes use unsupported features.
 */
export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: true,
};
