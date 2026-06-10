/**
 * Maps Archon credential-provider ids to Pi OAuth providers for subscription
 * login. Only these three Archon providers support subscription (OAuth) login;
 * everything else is API-key only.
 *
 * Pi's flows use the runtimes' own OAuth apps, so the minted credential is what
 * the native Claude/Codex providers accept — the delivery map routes it to the
 * native runtime (and, in PR-3, to the Pi runtime's `auth.json`). We use Pi's
 * exported provider singletons (not hard-coded id strings) and read `.id` off
 * them when calling `getOAuthApiKey`.
 */
import {
  anthropicOAuthProvider,
  openaiCodexOAuthProvider,
  githubCopilotOAuthProvider,
  type OAuthProviderInterface,
} from '@archon/providers/oauth';

/** Archon provider id → the Pi OAuth provider that drives its `login()`/refresh. */
export const ARCHON_TO_PI_OAUTH: Readonly<Record<string, OAuthProviderInterface>> = {
  claude: anthropicOAuthProvider,
  codex: openaiCodexOAuthProvider,
  copilot: githubCopilotOAuthProvider,
};

/**
 * Archon provider ids whose subscription (OAuth) login is wired but NOT usable
 * end-to-end, so we refuse to connect them (delivery/refresh code stays intact
 * for re-enable).
 *
 * - `codex`: Pi's `openaiCodexOAuthProvider` drops the OpenAI `id_token` from the
 *   token exchange (`openai-codex.js`), but the Codex CLI requires a valid
 *   `id_token` in `auth.json` — otherwise it crashes with "invalid ID token
 *   format". Verified broken on the VPS smoke (2026-06-08). API-key codex is
 *   unaffected. Re-enable once Pi surfaces `id_token` (or we capture it directly /
 *   support pasting a native `~/.codex/auth.json`). See #1924.
 */
const SUBSCRIPTION_DISABLED: ReadonlySet<string> = new Set(['codex']);

/** Archon provider ids that support OAuth subscription login (vs API key only). */
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set(
  Object.keys(ARCHON_TO_PI_OAUTH).filter(p => !SUBSCRIPTION_DISABLED.has(p))
);

/** The Pi OAuth provider for an Archon provider id, or undefined if it's API-key only. */
export function piOAuthProviderFor(provider: string): OAuthProviderInterface | undefined {
  return ARCHON_TO_PI_OAUTH[provider];
}
