/**
 * SDK-boundary wrapper around Pi's OAuth utilities.
 *
 * ⚠️ 0.83.0 migration note. The upstream Pi SDK REMOVED the OAuth value API this
 * module used to re-export (`getOAuthProvider`, `getOAuthApiKey`, and the
 * per-provider `OAuthProviderInterface` singletons) and replaced it with a
 * different, interaction-based `OAuthAuth` shape (`login(interaction)`,
 * `refresh`, `toAuth`) under `@earendil-works/pi-ai/auth/oauth/*`.
 *
 * Faithfully re-implementing subscription-connect on the new API requires a real
 * OAuth login to validate — the credential unit tests mock THIS module, so they
 * cannot cover a reimplementation — and getting credential refresh wrong breaks
 * auth silently. Subscription-connect is currently DORMANT on this deployment
 * (zero rows in `remote_agent_user_provider_keys`). So rather than ship an
 * unvalidated credential reimplementation, this module preserves the exact
 * type/value surface its consumers compile against and FAILS FAST (loud, never
 * silent) if the subscription-connect path is ever exercised.
 *
 * Native Claude / Claude-Code / Codex authentication is UNAFFECTED — it never
 * flows through `getOAuthApiKey`; it uses each runtime's own credential path.
 *
 * To re-enable subscription-connect on 0.83.0: port `login`/`refresh` to the new
 * `@earendil-works/pi-ai/auth/oauth` API (`anthropicOAuth` / `githubCopilotOAuth`
 * + `refresh`/`toAuth`) and validate with a real subscription login.
 */
export type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
} from '@earendil-works/pi-ai/oauth';

import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai/oauth';

/** Pi OAuth provider ids Archon references (was re-exported from pi-ai). */
export type OAuthProviderId = 'anthropic' | 'openai-codex' | 'github-copilot';

/**
 * Minimal surface Archon's credential layer compiles against — the subset of the
 * old Pi `OAuthProviderInterface` it actually used: the provider `id` and the
 * callbacks-based `login`.
 */
export interface OAuthProviderInterface {
  readonly id: OAuthProviderId;
  /** Whether the login flow binds a local callback server (used to detect port
   *  conflicts between concurrent logins). Always false on this build (disabled). */
  readonly usesCallbackServer: boolean;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}

const DISABLED_MSG =
  'Pi OAuth subscription-connect is unavailable on the @earendil-works/pi-* 0.83.0 build: ' +
  'the upstream OAuth value API was removed and the flow has not been re-ported. It is dormant ' +
  'here (no connected subscriptions), and native Claude/Codex auth is unaffected. To enable it, ' +
  'port login/refresh to the new pi-ai auth/oauth API and validate with a real login.';

function disabledProvider(id: OAuthProviderId): OAuthProviderInterface {
  return {
    id,
    usesCallbackServer: false,
    login(): Promise<OAuthCredentials> {
      throw new Error(DISABLED_MSG);
    },
  };
}

export const anthropicOAuthProvider = disabledProvider('anthropic');
export const openaiCodexOAuthProvider = disabledProvider('openai-codex');
export const githubCopilotOAuthProvider = disabledProvider('github-copilot');

const OAUTH_PROVIDERS: Readonly<Record<OAuthProviderId, OAuthProviderInterface>> = {
  anthropic: anthropicOAuthProvider,
  'openai-codex': openaiCodexOAuthProvider,
  'github-copilot': githubCopilotOAuthProvider,
};

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return OAUTH_PROVIDERS[id];
}

/**
 * Dormant on this build (see module header). Throws a clear, loud error so a
 * would-be subscription-connect resolution can never silently produce a wrong or
 * empty credential. Signature preserved for its single caller
 * (`user-provider-key-store.getUserProviderApiKey`).
 */
export function getOAuthApiKey(
  _providerId: string,
  _credentials: Record<string, unknown>
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  throw new Error(DISABLED_MSG);
}
