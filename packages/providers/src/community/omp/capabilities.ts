import type { ProviderCapabilities } from '../../types';

/**
 * OMP capabilities — mirrors PI_CAPABILITIES structure.
 * OMP supports MCP (via .mcp.json discovery), skills, and structured output.
 * Tool restrictions, thinking level, and env injection work similarly to Pi.
 *
 * TODO (MVP): wire up MCP, hooks, and cost control as they become tested.
 */
export const OMP_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
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
