/**
 * Capability declaration for the `provider:ollama` built-in.
 *
 * Honest reflection of TODAY's wiring — never potential support (#1195). Ollama
 * is a thin NDJSON HTTP shim; it lacks nearly every Claude/Codex feature.
 *
 *  - `sessionResume: false` — Ollama has no per-server session concept for v1;
 *    the provider logs a debug line and ignores `resumeSessionId`.
 *  - `mcp/hooks/skills/agents/toolRestrictions: false` — direct HTTP, no SDK.
 *  - `structuredOutput: 'best-effort'` — implemented as prompt augmentation
 *    (`augmentPromptForJsonSchema`) + post-parse validate, sibling of Pi/Copilot.
 *  - `envInjection: true` — forwarded verbatim into the fetch call env (only
 *    the `OLLAMA_BASE_URL` key is consulted for routing).
 *  - `costControl / effortControl / thinkingControl: false` — no such knobs.
 *  - `fallbackModel: false` — never fail over silently. If the user sets
 *    `fallbackModel`, the executor warns and forwards as-is.
 *  - `sandbox / nativeTools / containerExec: false` — direct HTTP, no in-process
 *    tool surface, no container integration today.
 */
import type { ProviderCapabilities } from '../types';

export const OLLAMA_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  knownToolNames: undefined,
  renamedTools: undefined,
  structuredOutput: 'best-effort',
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};
