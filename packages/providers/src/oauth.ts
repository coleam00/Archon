/**
 * SDK-boundary wrapper around Pi's OAuth utilities (`@earendil-works/pi-ai/oauth`).
 *
 * The Pi SDK dependency lives only in `@archon/providers`, so the rest of Archon
 * (the credential store + the subscription-connect bridge in `@archon/core`)
 * drives OAuth THROUGH this module instead of importing the SDK directly.
 *
 * Why this serves more than Pi: Pi's OAuth flows authenticate against the native
 * runtimes' OWN OAuth apps (the Claude Code app, the Codex CLI app, GitHub
 * Copilot), so the token Pi mints is exactly what the native Claude/Codex
 * providers already accept. One subscription connect therefore powers the native
 * runtimes, not just Pi — the delivery map (`@archon/core/credentials/delivery`)
 * routes the resolved credential to whichever provider consumes it.
 */
export {
  getOAuthProvider,
  getOAuthApiKey,
  anthropicOAuthProvider,
  openaiCodexOAuthProvider,
  githubCopilotOAuthProvider,
} from '@earendil-works/pi-ai/oauth';

export type {
  OAuthCredentials,
  OAuthProviderId,
  OAuthProviderInterface,
  OAuthLoginCallbacks,
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
} from '@earendil-works/pi-ai/oauth';
