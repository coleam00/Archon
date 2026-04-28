import type { ProviderCapabilities } from '../../types';

/**
 * Opencode capabilities — conservative v1 declaration. Flags must reflect
 * wired-up behavior; the dag-executor uses them to warn when a workflow node
 * specifies a feature the provider silently ignores.
 *
 * structuredOutput is best-effort (prompt-engineering only — opencode has no
 * SDK-level JSON mode). The provider appends a "respond with JSON matching
 * this schema" instruction and parses the accumulated assistant text on
 * session.idle. Reliable on instruction-following models; parse failures
 * surface via the dag-executor's existing dag.structured_output_missing path.
 *
 * mcp/hooks/skills/agents/toolRestrictions: opencode manages its own tool
 * ecosystem independently of Archon's layered tool configuration. These flags
 * remain false until a mapping layer is implemented.
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
