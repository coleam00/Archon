import type { ProviderCapabilities } from '../../types';

/**
 * Grok Build CLI capabilities for v1.
 *
 * Honest: only flags that `provider.ts` actually translates. YAML `skills:`
 * is ignored (Grok discovers SKILL.md and slash-commands itself). MCP,
 * sandbox, and toolRestrictions stay off until a follow-up maps `--allow` /
 * `--deny` / `--sandbox`.
 */
export const GROK_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  sessionFork: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'enforced',
  envInjection: true,
  costControl: false,
  effortControl: true,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};
