/**
 * Maps vendor-canonical credential ids to the flow that drives their
 * subscription (OAuth) login and refresh. Three vendors support subscription
 * login; everything else is API-key only.
 *
 * - `anthropic` / `github-copilot`: Pi's exported OAuth provider singletons
 *   drive `login()` and refresh. Pi's flows use the runtimes' own OAuth apps,
 *   so the minted credential is what the native runtimes accept — the
 *   delivery map routes it to the native runtime (and to the Pi runtime's
 *   `auth.json`). We read `.id` off the singletons when calling
 *   `getOAuthApiKey` (never hard-coded id strings).
 * - `openai` (ChatGPT/Codex): an Archon-OWNED PKCE flow (`openai-oauth.ts`)
 *   handles BOTH login and refresh, because Pi's `openaiCodexOAuthProvider`
 *   drops the `id_token` the Codex CLI requires (#1924). It is therefore
 *   deliberately absent from `ARCHON_TO_PI_OAUTH` — `piOAuthProviderFor`
 *   returning undefined for `openai` is what routes the bridge and the
 *   refresh path to the Archon flow.
 */
import {
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  type OAuthProviderInterface,
} from '@archon/providers/oauth';
import { normalizeCredentialVendor } from './delivery';

/** Vendor id → the Pi OAuth provider that drives its `login()`/refresh. */
export const ARCHON_TO_PI_OAUTH: Readonly<Record<string, OAuthProviderInterface>> = {
  anthropic: anthropicOAuthProvider,
  'github-copilot': githubCopilotOAuthProvider,
};

/** The vendor whose subscription flow is Archon-owned (see header + #1924). */
export const OPENAI_SUBSCRIPTION_VENDOR = 'openai';

/** Vendor ids that support OAuth subscription login (vs API key only). */
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  ...Object.keys(ARCHON_TO_PI_OAUTH),
  OPENAI_SUBSCRIPTION_VENDOR,
]);

/**
 * The Pi OAuth provider for a credential id (vendor-canonical or legacy
 * agent-keyed), or undefined if its flow is not Pi-driven (`openai` — Archon
 * owns it) or it's API-key only.
 */
export function piOAuthProviderFor(provider: string): OAuthProviderInterface | undefined {
  return ARCHON_TO_PI_OAUTH[normalizeCredentialVendor(provider)];
}
