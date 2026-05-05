import type { ProviderCapabilities } from '../../types';

/**
 * OpenCode capabilities — all false for the PoC.
 * The first iteration doesn't implement session resume, MCP, hooks, skills,
 * agents, tool restrictions, structured output, env injection, cost control,
 * effort control, thinking control, fallback model, or sandbox.
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
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
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
