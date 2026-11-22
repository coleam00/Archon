import type { ProviderCapabilities } from '../../types';

/**
 * ZCode CLI capabilities — one headless `zcode -p` call per turn, so the provider
 * reports only what that surface verifiably offers (probed 2026-11-22):
 *  - sessionResume: `--resume <sessionId>` restores context, same session id.
 *  - toolRestrictions: `--disallowed-tools` removes whole tools for the run.
 *  - tokenReporting / turnCountReporting: the `--json` epilogue carries usage
 *    (input/output/total) and projection.turnCount.
 *
 * Everything translation-shaped is `false` on purpose: a `true` here silences the
 * dag-executor's ignored-capability warning, which would drop a node's MCP/skills/
 * hooks/plugins silently (#2116 fail-fast discipline).
 */
export const ZCODE_CAPABILITIES: ProviderCapabilities = {
  backgroundWork: 'unobserved',
  sessionResume: true,
  mcp: false, // nodeConfig.mcp has no zcode translation; zcode loads its own MCP config
  hooks: false,
  skills: false, // zcode loads ~/.zcode skills natively; per-node skills: has no translation
  plugins: false,
  agents: false,
  toolRestrictions: true, // --disallowed-tools
  structuredOutput: false, // no grammar enforcement; output_format would be silently dropped
  requiresAllPropertiesRequired: false,
  envInjection: true, // spawn-per-call inherits the request env bag
  costControl: false,
  costReporting: false, // CLI epilogue reports tokens only, no cost
  tokenReporting: true,
  stopReasonReporting: false,
  turnCountReporting: true, // projection.turnCount
  resolvedModelReporting: false, // the epilogue does not name the model
  effortControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};
