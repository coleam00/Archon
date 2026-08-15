import type { ProviderCapabilities } from '../../types';

/**
 * AiderDesk provider capabilities — reflects only features actually wired
 * into the provider implementation.
 *
 * The dag-executor uses these to warn users when a workflow node specifies a
 * feature the provider ignores. Declaring `true` for an unwired feature is
 * a fail-fast violation (#2116) — it would suppress the dag-executor's
 * ignored-capability warning and drop the node config silently.
 *
 * AiderDesk wraps a REST API that delegates inference to its own agent
 * infrastructure (which can use Ollama for zero-cost local inference).
 * It is HTTP-only — no SDK subprocess, no in-process tool injection.
 */
export const AIDERDESK_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true, // AiderDesk tasks persist — resume by loading task ID
  mcp: false, // No translation site for nodeConfig.mcp
  hooks: false, // No Claude-SDK-shaped hook callbacks
  skills: false, // AiderDesk has its own skill system; no translation site
  agents: false, // No inline sub-agent definitions
  toolRestrictions: false, // AiderDesk manages its own tools
  structuredOutput: 'best-effort', // Prompt augmentation + validate (no SDK grammar)
  envInjection: true, // Env vars passed through to AiderDesk task context
  costControl: false, // No maxBudgetUsd translation
  effortControl: false, // AiderDesk handles effort via agent profile config
  thinkingControl: false, // No thinking level translation
  fallbackModel: false, // No fallback model support
  sandbox: false, // No sandbox execution
  settingSources: false, // Claude Agent SDK-only knob
  nativeTools: false, // No in-process tool injection
  containerExec: false, // No in-container spawn path (HTTP-only provider)
};
