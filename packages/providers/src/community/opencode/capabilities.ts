import type { ProviderCapabilities } from '../../types';

/**
 * OpenCode SDK capabilities — reflects actual SDK features only.
 * The dag-executor uses these to warn users when a workflow node
 * specifies a feature the provider ignores.
 *
 * Agents semantics differ from Claude SDK: OpenCode supports agent
 * selection via adaptation layer. The `agents: true` flag enables
 * `nodeConfig.agents` translation to OpenCode request fields:
 * - agent selection (named agent from opencode.json config)
 * - model override per-call
 * - tools/permissions map for scoping
 *
 * NOT full programmatic inline agent definitions like Claude SDK's
 * `options.agents` array — OpenCode uses config-file-based agents.
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: false,
  sandbox: false,
};
