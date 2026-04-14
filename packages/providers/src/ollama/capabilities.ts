import type { ProviderCapabilities } from '../types';

/**
 * Ollama capability flags.
 * Ollama runs locally via /api/chat — no session resume, MCP, hooks, or SDK-level
 * tool restrictions. Structured output, cost control, effort, and sandbox are also
 * unsupported at this time.
 */
export const OLLAMA_CAPABILITIES: ProviderCapabilities = {
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
