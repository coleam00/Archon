import type { ProviderCapabilities } from '../../types';

/**
 * OpenCode SDK capabilities — reflects actual SDK features only.
 * The dag-executor uses these to warn users when a workflow node
 * specifies a feature the provider ignores.
 *
 * Agents semantics differ from Claude SDK: OpenCode supports agent
 * selection via adaptation layer. The `agents: true` flag enables
 * `nodeConfig.agents` translation to OpenCode request fields (wired in
 * provider.ts: `getOrderedAgents` → `materializeAgents`):
 * - agent selection (named agent from opencode.json config)
 * - model override per-call
 * - tools/permissions map for scoping
 *
 * NOT full programmatic inline agent definitions like Claude SDK's
 * `options.agents` array — OpenCode uses config-file-based agents.
 *
 * `hooks: false` — Archon's per-node `hooks` field carries Claude-SDK-shaped
 * `HookCallbackMatcher` callbacks and the OpenCode provider has no translation
 * site for them (grep the provider dir: `hooks` appears only here). Declaring
 * `true` would suppress the dag-executor's ignored-capability warning and drop
 * a node's hooks silently — a fail-fast violation (#2116).
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced', // sends format:{json_schema}; reads info.structured_output
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false, // OpenCode handles effort/thinking via opencode.json agent config, not prompt body
  fallbackModel: false,
  sandbox: false,
  nativeTools: false,
  containerExec: false, // no in-container spawn path yet (fail-fast source of truth)
};
