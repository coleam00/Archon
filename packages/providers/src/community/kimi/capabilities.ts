import type { ProviderCapabilities } from '../../types';

/**
 * Kimi K2.5 (via OpenRouter) capabilities.
 *
 * Kimi is a streaming chat-completion provider — no session resume, no tools,
 * no MCP. Use it for content generation and synthesis nodes in a DAG where
 * Claude handles agentic/tool-heavy nodes (per-node model routing pattern).
 *
 * structuredOutput is best-effort via prompt augmentation (JSON schema
 * appended to the user message). Reliable on Kimi K2.5's instruction following.
 */
export const KIMI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
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
