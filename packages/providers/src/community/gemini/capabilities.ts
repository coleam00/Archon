import type { ProviderCapabilities } from '../../types';

/**
 * Gemini v1 capabilities — intentionally conservative. Declared flags reflect
 * wired-up behavior, not potential support, so the dag-executor can warn users
 * when a workflow node specifies a feature this provider ignores.
 *
 * sessionResume: true — QueryOptions.session accepts a bare session-id string.
 * toolRestrictions: true — QueryOptions.allowedTools maps to --allowed-tools.
 * envInjection: true — QueryOptions.env is merged into the subprocess env; the
 *   subprocess also inherits the parent process env (including HOME), so the
 *   ambient ~/.gemini OAuth login resolves without any key injection.
 *
 * mcp: false — Archon's nodeConfig.mcp is a file-path string ref, while the SDK
 *   expects an mcpServers object map. Translation is deferred to v2.
 * structuredOutput: false — outputSchema only works with the SDK's buffered
 *   queryFull(); calling query() with it throws UnsupportedFeatureError, and
 *   query() is required for Archon's streaming AsyncGenerator contract.
 */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
