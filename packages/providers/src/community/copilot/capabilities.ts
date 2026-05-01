/**
 * GitHub Copilot CLI community provider — capabilities declaration.
 *
 * Conservative initial set: only flags for features that are wired up.
 * The dag-executor uses these to warn when a workflow node specifies
 * a feature the provider does not support.
 */
import type { ProviderCapabilities } from '../../types';

/**
 * sessionResume: false — Copilot CLI is stateless per invocation.
 * mcp:           false — not exposed via CLI flags.
 * hooks:         false — Claude-SDK-specific lifecycle hooks.
 * skills:        true  — system-prompt-level skills are injected into the prompt.
 * agents:        true  — inline sub-agents are supported via system prompt injection.
 * toolRestrictions: true — --allow-tool / --deny-tool flags are fully wired.
 * structuredOutput: false — no JSON-mode in v1.
 * envInjection:  true  — request env merged over process.env before spawn.
 * costControl:   false — no token budget API in the CLI.
 * effortControl: false — no reasoning-effort flag in v1.
 * thinkingControl: false — no thinking-level flag in v1.
 * fallbackModel: true  — retries once with fallbackModel on rate-limit/model-access failures.
 * sandbox:       false — not wired.
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: true,
  sandbox: false,
};
