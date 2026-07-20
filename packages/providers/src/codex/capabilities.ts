import type { ProviderCapabilities } from '../types';

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true, // filesystem autodiscovery from .agents/skills/ — not per-node injection; nodeConfig.skills is ignored
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'enforced', // SDK outputSchema grammar-constrains decoding
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
  nativeTools: false,
  containerExec: false, // no in-container spawn path yet (fail-fast source of truth)
};
