/**
 * Per-user AI-provider credential delivery map (Phase 2, vendor-canonical
 * since #1955).
 *
 * Pure-function "how to hand a credential to vendor X" table. Given a
 * vendor-canonical credential id and a decrypted credential (`api_key` or
 * `oauth`), returns the env vars to merge into the workflow / chat env and,
 * optionally, files to write under `artifactsDir` (e.g. Codex
 * `CODEX_HOME/auth.json` for ChatGPT subscription delivery).
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
import { join } from 'node:path';
import { PI_PROVIDER_ENV_VARS, PI_AMBIENT_VENDORS } from '@archon/providers';

/**
 * Pre-#1955 agent-keyed credential ids → vendor-canonical ids. Accepted at
 * every entry point (connect, delivery, CLI) so in-flight callers and
 * not-yet-migrated rows keep working; storage always uses the vendor id.
 */
export const LEGACY_VENDOR_ALIASES: Readonly<Record<string, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  copilot: 'github-copilot',
};

/** Map a (possibly legacy agent-keyed) credential id to its vendor-canonical id. */
export function normalizeCredentialVendor(id: string): string {
  return LEGACY_VENDOR_ALIASES[id] ?? id;
}

/**
 * Raw OAuth credential blob as returned by `@earendil-works/pi-ai/oauth`
 * provider `login()`. The exact shape varies per provider (Anthropic vs. Codex
 * vs. Copilot) but is always a JSON-serializable object. It's stored opaquely
 * and passed through verbatim: refresh is handled by Pi's `getOAuthApiKey`
 * (keyed by Pi's provider id, e.g. `openai-codex` — not Archon's `codex`), and
 * the only field-level parsing is `buildCodexAuthJson` below.
 */
export type OAuthCredentials = Record<string, unknown>;

/**
 * A decrypted user credential ready to be delivered to a provider. For API
 * keys the secret is a plain bearer string; for OAuth subscriptions the
 * `oauthApiKey` is a usable bearer derived via Pi's `getOAuthApiKey` (with
 * `rawCreds` preserved so refresh-on-rotation can re-save).
 */
export type ResolvedCredential =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'oauth'; oauthApiKey: string; rawCreds: OAuthCredentials };

export interface DeliveryResult {
  env: Record<string, string>;
  /** Files to write before the provider is invoked (e.g. Codex auth.json). */
  files?: { path: string; contents: string }[];
}

export interface DeliveryOptions {
  /**
   * Per-run artifacts directory. File-based deliveries (Codex `auth.json`)
   * are written under this directory so they're scoped to the run and don't
   * leak across users. Pass empty string from the direct-chat path to signal
   * "env-only deliveries"; chat callers MUST drop deliveries that produce
   * files when no artifactsDir is available (see orchestrator-agent).
   */
  artifactsDir: string;
}

/**
 * The set of vendor ids the delivery map can turn into env/files — i.e. the
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
 * Map Pi's `openaiCodex` OAuth blob onto the Codex CLI `auth.json` shape
 * (authoritative interface: `packages/server/src/scripts/setup-auth.ts`):
 *   { OPENAI_API_KEY: null, tokens: { id_token, access_token, refresh_token,
 *     account_id }, last_refresh }
 *
 * Pi's `OAuthCredentials` (verified against `pi-ai@0.76.0`
 * `dist/utils/oauth/openai-codex.js:100-104,332`) is `{ access, refresh, expires,
 * accountId }` — note `accountId` is camelCase, and **Pi does not surface an
 * `id_token`** (`chatgpt_account_id` is only an internal JWT claim it reads to
 * derive `accountId`). So `id_token` is best-effort (empty unless a future Pi
 * version provides one).
 *
 * VERIFY (gated on #1924): whether the Codex CLI accepts an empty `id_token`
 * for a ChatGPT subscription, or derives the account from the JWT
 * `access_token` alone. Moot until the `openai` subscription connect gate
 * (SUBSCRIPTION_DISABLED) is lifted — this path is unreachable from connect
 * today. The API-key path (`OPENAI_API_KEY`) is unaffected.
 */
function buildCodexAuthJson(rawCreds: OAuthCredentials): string {
  const c = rawCreds as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: str(c.id_token), // Pi does not provide one today → ''
      access_token: str(c.access),
      refresh_token: str(c.refresh),
      account_id: str(c.accountId),
    },
    last_refresh: new Date().toISOString(),
  });
}

/**
 * Translate `(provider, credential)` → env (and optional files) to be merged
 * into the per-run / per-chat env bag. Throws on unknown providers so callers
 * fail fast instead of silently swallowing the credential.
 *
 * Env-only callers (direct chat with no artifactsDir) MUST drop results that
 * include `files` — chat has no per-call scratch directory to host them.
 */
export function deliverCredential(
  provider: string,
  cred: ResolvedCredential,
  opts: DeliveryOptions
): DeliveryResult {
  const vendor = normalizeCredentialVendor(provider);
  switch (vendor) {
    case 'anthropic':
      if (cred.kind === 'api_key') {
        // CLAUDE_API_KEY kept alongside ANTHROPIC_API_KEY for parity with the
        // pre-#1955 'claude' delivery (harmless superset).
        return { env: { ANTHROPIC_API_KEY: cred.apiKey, CLAUDE_API_KEY: cred.apiKey } };
      }
      // Claude Pro/Max subscription → the token var the Claude SDK reads.
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: cred.oauthApiKey } };

    case 'openai':
      if (cred.kind === 'api_key') {
        return { env: { OPENAI_API_KEY: cred.apiKey } };
      }
      {
        // ChatGPT subscription → Codex CLI auth.json (connect-gated, #1924).
        const codexHome = join(opts.artifactsDir, 'codex-home');
        return {
          env: { CODEX_HOME: codexHome },
          files: [
            { path: join(codexHome, 'auth.json'), contents: buildCodexAuthJson(cred.rawCreds) },
          ],
        };
      }

    case 'github-copilot':
      // Copilot subscription (oauth) or a Copilot PAT (api_key) → the env var the
      // native Copilot provider reads (COPILOT_GITHUB_TOKEN wins over generic GH
      // tokens). VERIFY (live): the OAuth-minted Copilot token works as this PAT.
      return {
        env: {
          COPILOT_GITHUB_TOKEN: cred.kind === 'api_key' ? cred.apiKey : cred.oauthApiKey,
        },
      };

    default: {
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
  }
}

/**
 * A Pi `AuthStorage` `auth.json` entry (see `@earendil-works/pi-coding-agent`
 * `core/auth-storage.d.ts`): an API key or an OAuth blob, keyed by Pi provider id.
 */
type PiAuthCredential = { type: 'api_key'; key: string } | ({ type: 'oauth' } & OAuthCredentials);

/** Relative path (under the per-run artifacts dir) for the generated Pi auth.json. */
export const PI_AUTH_JSON_RELATIVE_PATH = 'pi-home/auth.json';
/** Env var the Pi provider reads to point `AuthStorage` at the per-run auth.json. */
export const PI_AUTH_PATH_ENV = 'ARCHON_PI_AUTH_PATH';

/**
 * Build a per-run Pi `auth.json` from the user's FULL connected credential set so
 * a `pi` node can use the user's API keys AND subscriptions. Returns `null` when
 * no credential maps to a Pi backend. Delivered via a per-run auth path
 * (`ARCHON_PI_AUTH_PATH`) — NOT by moving `PI_CODING_AGENT_DIR`, which would
 * redirect Pi's whole home and drop the user's `models.json`/`settings.json`.
 */
export function buildPiAuthJson(
  creds: { provider: string; cred: ResolvedCredential }[]
): string | null {
  const data: Record<string, PiAuthCredential> = {};
  for (const { provider, cred } of creds) {
    // Vendor ids ARE Pi backend ids since #1955 (legacy agent-keyed rows are
    // normalized); anything not in the generated map isn't a Pi backend.
    //
    // VERIFY (T5b.0): the OAuth backend ids (`openai`, `github-copilot`)
    // against a real `~/.pi/agent/auth.json` after a local `pi` `/login`.
    const piId = normalizeCredentialVendor(provider);
    if (!(piId in PI_PROVIDER_ENV_VARS)) continue;
    data[piId] =
      cred.kind === 'api_key'
        ? { type: 'api_key', key: cred.apiKey }
        : { type: 'oauth', ...cred.rawCreds };
  }
  return Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : null;
}
