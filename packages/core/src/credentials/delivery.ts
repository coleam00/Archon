/**
 * Per-user AI-provider credential delivery map (Phase 2).
 *
 * Pure-function "how to hand a credential to provider X" table. Given a
 * provider id and a decrypted credential (`api_key` or `oauth`), returns the
 * env vars to merge into the workflow / chat env and, optionally, files to
 * write under `artifactsDir` (e.g. Codex `CODEX_HOME/auth.json` for ChatGPT
 * subscription delivery).
 *
 * Single source of truth — extend this map when adding a new provider rather
 * than forking per-provider branches in the executor or orchestrator.
 *
 * Env var names for Pi backends are sourced from
 * `packages/providers/src/community/pi/provider.ts:PI_PROVIDER_ENV_VARS`
 * (kept in sync with pi-ai's upstream env-api-keys map).
 */
import { join } from 'node:path';

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
 * Pi backend providers → env var name. Kept in lockstep with
 * `PI_PROVIDER_ENV_VARS` in `packages/providers/src/community/pi/provider.ts`.
 * When updating one, update both (intentional small duplication to avoid a
 * cross-package import from `@archon/core` into `@archon/providers`).
 *
 * Note: `anthropic` and `openai` are intentionally absent here — they are
 * handled by explicit `case` branches in `deliverCredential` (they reject
 * OAuth and map the same env vars, but the switch path is authoritative).
 */
const PI_PROVIDER_ENV_VARS: Record<string, string> = {
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
};

/**
 * The set of provider ids the delivery map understands. Used at connect time
 * to fail fast on typos before encrypting and persisting a key for a
 * provider we can't actually deliver.
 *
 * Note: `claude` / `codex` are the Archon-level provider ids. `anthropic` /
 * `openai` are alias providers handled by explicit switch cases in
 * `deliverCredential` — they map the same env vars as the Pi backends but
 * reject OAuth (direct subscription is routed through `claude` / `codex`).
 * All remaining entries are Pi-backend ids sourced from PI_PROVIDER_ENV_VARS.
 */
export const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<string>([
  'claude',
  'codex',
  'copilot',
  'anthropic',
  'openai',
  ...Object.keys(PI_PROVIDER_ENV_VARS),
]);

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
 * VERIFY (live smoke): whether the Codex CLI accepts an empty `id_token` for a
 * ChatGPT subscription, or derives the account from the JWT `access_token` alone.
 * The API-key Codex path (`OPENAI_API_KEY`) is unaffected.
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
  switch (provider) {
    case 'claude':
      if (cred.kind === 'api_key') {
        return { env: { CLAUDE_API_KEY: cred.apiKey, ANTHROPIC_API_KEY: cred.apiKey } };
      }
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: cred.oauthApiKey } };

    case 'codex':
      if (cred.kind === 'api_key') {
        return { env: { OPENAI_API_KEY: cred.apiKey } };
      }
      {
        const codexHome = join(opts.artifactsDir, 'codex-home');
        return {
          env: { CODEX_HOME: codexHome },
          files: [
            { path: join(codexHome, 'auth.json'), contents: buildCodexAuthJson(cred.rawCreds) },
          ],
        };
      }

    case 'copilot':
      // Copilot subscription (oauth) or a Copilot PAT (api_key) → the env var the
      // native Copilot provider reads (COPILOT_GITHUB_TOKEN wins over generic GH
      // tokens). VERIFY (live): the OAuth-minted Copilot token works as this PAT.
      return {
        env: {
          COPILOT_GITHUB_TOKEN: cred.kind === 'api_key' ? cred.apiKey : cred.oauthApiKey,
        },
      };

    case 'anthropic':
      if (cred.kind === 'oauth') {
        throw new Error(
          "Provider 'anthropic' does not support OAuth subscription delivery — use provider 'claude' for the Claude Pro/Max subscription path."
        );
      }
      return { env: { ANTHROPIC_API_KEY: cred.apiKey } };

    case 'openai':
      if (cred.kind === 'oauth') {
        throw new Error(
          "Provider 'openai' does not support OAuth subscription delivery — use provider 'codex' for the ChatGPT subscription path."
        );
      }
      return { env: { OPENAI_API_KEY: cred.apiKey } };

    default: {
      const piEnvVar = PI_PROVIDER_ENV_VARS[provider];
      if (piEnvVar) {
        if (cred.kind === 'oauth') {
          // Reached only if an oauth row exists under a Pi-backend id (connect
          // guards against this — oauth is claude/codex/copilot only). The Pi
          // runtime consumes subscriptions via the aggregate auth.json
          // (buildPiAuthJson), not this per-provider env path.
          throw new Error(
            `Provider '${provider}' (Pi backend) has no env-based OAuth delivery; subscriptions reach Pi via auth.json.`
          );
        }
        return { env: { [piEnvVar]: cred.apiKey } };
      }
      throw new Error(
        `Unknown credential provider '${provider}'. Known: ${[...KNOWN_PROVIDERS].sort().join(', ')}.`
      );
    }
  }
}

/**
 * A Pi `AuthStorage` `auth.json` entry (see `@earendil-works/pi-coding-agent`
 * `core/auth-storage.d.ts`): an API key or an OAuth blob, keyed by Pi provider id.
 */
type PiAuthCredential = { type: 'api_key'; key: string } | ({ type: 'oauth' } & OAuthCredentials);

/**
 * Archon credential-provider id → Pi provider/backend id (the `auth.json` key Pi
 * looks under when running that backend). Mostly identity for API-key backends;
 * the runtime ids (`claude`/`codex`/`copilot`) map to Pi's backend names.
 *
 * VERIFY (T5b.0): the OAuth backend ids (`codex`→`openai`, `copilot`→`github-copilot`)
 * against a real `~/.pi/agent/auth.json` after a local `pi` `/login`.
 */
const PI_BACKEND_ID: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  copilot: 'github-copilot',
  anthropic: 'anthropic',
  openai: 'openai',
  ...Object.fromEntries(Object.keys(PI_PROVIDER_ENV_VARS).map(p => [p, p])),
};

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
    const piId = PI_BACKEND_ID[provider];
    if (!piId) continue;
    data[piId] =
      cred.kind === 'api_key'
        ? { type: 'api_key', key: cred.apiKey }
        : { type: 'oauth', ...cred.rawCreds };
  }
  return Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : null;
}
