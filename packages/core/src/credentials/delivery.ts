/**
 * Per-user AI-provider credential delivery map (Phase 2, vendor-canonical
 * since #1955).
 *
 * Pure-function "how to hand a credential to vendor X" table. Given a
 * vendor-canonical credential id and a decrypted credential (`api_key` or
 * `oauth`), returns the env vars to merge into the workflow / chat env. Every
 * delivery is env-only, so workflows and direct chat receive the same
 * credential, and no provider home directory is replaced to deliver one.
 *
 * Credential ids are upstream-vendor keyed (`anthropic`, `openai`,
 * `github-copilot`, plus the Pi backend ids) — NOT agent ids: one credential
 * can serve multiple agents (an `anthropic` key powers Claude Code, Pi's
 * anthropic backend, and OpenCode). Legacy agent-keyed ids (`claude`/`codex`/
 * `copilot`) are normalized via {@link normalizeCredentialVendor}; stored rows
 * are migrated at startup (see migrations/000_combined.sql + the SQLite
 * adapter's migrateColumns).
 *
 * Env var names for Pi backends come from the generated
 * `PI_PROVIDER_ENV_VARS` (@archon/providers, regenerated from the installed
 * pi-ai SDK — `bun run check:pi-vendor-map` guards drift).
 */
import { consumesStoredCredential } from '@archon/provider-contract';
import {
  CODEX_CREDENTIAL_ENV,
  PI_PROVIDER_ENV_VARS,
  PI_AMBIENT_VENDORS,
  normalizeCredentialVendor,
} from '@archon/providers';
import { descriptor as piDescriptor } from '@archon/providers/pi/descriptor';
import { PI_AUTH_PATH_ENV } from '@archon/providers/pi/auth-path-env';
import { PI_AUTH_JSON_RELATIVE_PATH } from '@archon/workflows/deps';

export { LEGACY_VENDOR_ALIASES, normalizeCredentialVendor } from '@archon/providers';

/** Vendor-specific JSON blob, stored encrypted and refreshed by core's OAuth flows. */
export type OAuthCredentials = Record<string, unknown>;

/**
 * A decrypted user credential ready to be delivered to a provider. For API
 * keys the secret is a plain bearer string; for OAuth subscriptions the
 * `oauthApiKey` is a usable bearer derived by core's subscription flow (with
 * `rawCreds` preserved so refresh-on-rotation can re-save).
 */
export type ResolvedCredential =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'oauth'; oauthApiKey: string; rawCreds: OAuthCredentials };

export interface DeliveryResult {
  env: Record<string, string>;
}

/**
 * The set of vendor ids the delivery map can turn into env — i.e. the
 * connectable catalog. Derived from the generated Pi backend map (which
 * already includes `anthropic`, `openai`, and `github-copilot`); ambient
 * vendors (AWS Bedrock, Vertex ADC) are detection-only and excluded. Used at
 * connect time to fail fast on typos before encrypting and persisting a key
 * we could never deliver. Legacy agent-keyed ids are accepted via
 * {@link normalizeCredentialVendor}, not listed here.
 */
export const KNOWN_VENDORS: ReadonlySet<string> = new Set<string>(
  // Every key-vendor in the generated map is deliverable. Ambient-ONLY vendors
  // (amazon-bedrock) are absent from the env map by construction; google-vertex
  // appears in both (API key OR ambient ADC) and stays connectable.
  Object.keys(PI_PROVIDER_ENV_VARS)
);

/**
 * Translate `(provider, credential)` → env to be merged into the per-run /
 * per-chat env bag. Throws on unknown providers so callers fail fast instead
 * of silently swallowing the credential.
 */
export function deliverCredential(provider: string, cred: ResolvedCredential): DeliveryResult {
  const vendor = normalizeCredentialVendor(provider);
  switch (vendor) {
    case 'anthropic':
      return deliverAnthropic(cred);
    case 'openai':
      return deliverOpenAi(cred);
    case 'github-copilot':
      // Copilot subscription (oauth) or a Copilot PAT (api_key) → the env var the
      // native Copilot provider reads (COPILOT_GITHUB_TOKEN wins over generic GH
      // tokens). VERIFY (live): the OAuth-minted Copilot token works as this PAT.
      return {
        env: {
          COPILOT_GITHUB_TOKEN: cred.kind === 'api_key' ? cred.apiKey : cred.oauthApiKey,
        },
      };
    default:
      return deliverPiBackend(vendor, cred);
  }
}

function deliverAnthropic(cred: ResolvedCredential): DeliveryResult {
  if (cred.kind === 'api_key') {
    // CLAUDE_API_KEY kept alongside ANTHROPIC_API_KEY for parity with the
    // pre-#1955 'claude' delivery (harmless superset).
    return { env: { ANTHROPIC_API_KEY: cred.apiKey, CLAUDE_API_KEY: cred.apiKey } };
  }
  // Claude Pro/Max subscription, read by the native Claude SDK. It is not delivered
  // under a Pi variable: a Claude subscription runs only on the Claude provider.
  return { env: { CLAUDE_CODE_OAUTH_TOKEN: cred.oauthApiKey } };
}

function deliverOpenAi(cred: ResolvedCredential): DeliveryResult {
  if (cred.kind === 'api_key') {
    // Pi reads OPENAI_API_KEY; Codex reads only its own name.
    return { env: { OPENAI_API_KEY: cred.apiKey, [CODEX_CREDENTIAL_ENV.apiKey]: cred.apiKey } };
  }
  // ChatGPT subscription → the Codex provider logs its app-server in with these
  // in memory, so the user's CODEX_HOME stays theirs.
  const accountId = cred.rawCreds.accountId;
  if (typeof accountId !== 'string' || accountId === '') {
    throw new Error(
      'Stored OpenAI subscription has no ChatGPT account id; reconnect it with `archon ai login openai`.'
    );
  }
  return {
    env: {
      [CODEX_CREDENTIAL_ENV.chatgptAccessToken]: cred.oauthApiKey,
      [CODEX_CREDENTIAL_ENV.chatgptAccountId]: accountId,
    },
  };
}

function deliverPiBackend(vendor: string, cred: ResolvedCredential): DeliveryResult {
  // Happy path first: any vendor in the generated env map delivers its
  // API key. This includes google-vertex, which is BOTH api_key-capable
  // and ambient — a stored Vertex key must deliver, so the env lookup
  // takes precedence over the ambient check.
  const piEnvVar = PI_PROVIDER_ENV_VARS[vendor];
  if (piEnvVar) {
    if (cred.kind === 'oauth') {
      // Reached only if an oauth row exists under a Pi-backend id (connect
      // guards against this — oauth is anthropic/openai/github-copilot
      // only). The Pi runtime consumes subscriptions via the aggregate
      // auth.json (buildPiAuthJson), not this per-vendor env path.
      throw new Error(
        `Vendor '${vendor}' (Pi backend) has no env-based OAuth delivery; subscriptions reach Pi via auth.json.`
      );
    }
    return { env: { [piEnvVar]: cred.apiKey } };
  }
  if (PI_AMBIENT_VENDORS.includes(vendor)) {
    // Ambient-ONLY vendors (amazon-bedrock — no env var in the map):
    // chains are detected from the environment, never stored — a stored
    // row for one is a connect bug.
    throw new Error(
      `Vendor '${vendor}' uses ambient cloud credentials and has no stored-credential delivery.`
    );
  }
  throw new Error(
    `Unknown credential vendor '${vendor}'. Known: ${[...KNOWN_VENDORS].sort().join(', ')}.`
  );
}

/**
 * A Pi `AuthStorage` `auth.json` entry (see `@earendil-works/pi-coding-agent`
 * `core/auth-storage.d.ts`): an API key or an OAuth blob, keyed by Pi provider id.
 */
type PiAuthCredential = { type: 'api_key'; key: string } | ({ type: 'oauth' } & OAuthCredentials);

/** Relative path (under the per-run artifacts dir) for the generated Pi auth.json. */
export { PI_AUTH_JSON_RELATIVE_PATH };
/** Env var the Pi provider reads to point `AuthStorage` at the per-run auth.json. */
export { PI_AUTH_PATH_ENV };

/**
 * Build a per-run Pi `auth.json` from the user's connected credentials that Pi
 * consumes: API keys for its backends and the subscriptions its credential spec
 * declares. Returns `null` when none qualifies. Delivered via a per-run auth path
 * (`ARCHON_PI_AUTH_PATH`) — NOT by moving `PI_CODING_AGENT_DIR`, which would
 * redirect Pi's whole home and drop the user's `models.json`/`settings.json`.
 */
export function buildPiAuthJson(
  creds: { provider: string; cred: ResolvedCredential }[]
): string | null {
  const data: Record<string, PiAuthCredential> = {};
  for (const { provider, cred } of creds) {
    // Vendor ids ARE Pi backend ids since #1955 (legacy agent-keyed rows are
    // normalized); Pi's credential spec decides which of them it consumes.
    //
    // VERIFY (T5b.0): the OAuth backend ids (`openai`, `github-copilot`)
    // against a real `~/.pi/agent/auth.json` after a local `pi` `/login`.
    // NOTE: the `openai` oauth blob carries an extra `id_token` field (Archon's
    // own flow, #1924) — Pi tolerates it: its `OAuthCredentials` type is
    // index-signature open (`[key: string]: unknown`) and its refresh/getApiKey
    // only read access/refresh/expires/accountId.
    const piId = normalizeCredentialVendor(provider);
    if (!consumesStoredCredential(piDescriptor.credentials, piId, cred.kind)) continue;
    data[piId] =
      cred.kind === 'api_key'
        ? { type: 'api_key', key: cred.apiKey }
        : { type: 'oauth', ...cred.rawCreds };
  }
  return Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : null;
}
