import type { ProviderCapabilities } from '../../types';

/**
 * Starting point for a community provider's `capabilities.ts`.
 *
 * Declare only what you have actually wired. Under-declaration is self-correcting:
 * the dag-executor warns when a node uses a feature you set to `false`. Over-declaration
 * is silent — Archon drops the configuration.
 *
 * Typed as `ProviderCapabilities` so a capability the interface requires cannot go
 * missing from the template a contributor copies.
 */
export const YOUR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,

  // Optional axes — omit any your provider does not support.
  // sessionFork: false,
  // knownToolNames: ['Read', 'Write'],
  // renamedTools: { Task: 'Agent' },
};
