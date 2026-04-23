import type { ProviderCapabilities } from '../../types';

/**
 * OpenCode capabilities — intentionally conservative. Declared flags must
 * reflect wired-up behavior, not potential support. The dag-executor uses
 * these to warn users when a workflow node specifies a feature the provider
 * ignores.
 *
 * OpenCode is a client/server AI coding agent with native MCP support,
 * structured output, and session management. Unlike Pi, it does not require
 * package.json shims or filesystem session stores.
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
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
