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
 * provider `login()`. The exact shape varies per provider (Anthropic vs.
 * Codex vs. Copilot) but is always a JSON-serializable object. Phase 2 stores
 * it opaquely; the OAuth bridge (PR-3) is responsible for parsing the
 * provider-specific fields.
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
  'anthropic',
  'openai',
  ...Object.keys(PI_PROVIDER_ENV_VARS),
]);

/**
 * Codex ChatGPT-subscription `auth.json` shape verification is deferred to
 * the OAuth-delivery PR (G5 / T23–T24). For now this helper JSON-stringifies
 * the raw Pi credential blob verbatim — that is a placeholder; the field
 * mapping to the real Codex CLI `auth.json` is the work of T23/T24 and may
 * change.
 */
function buildCodexAuthJson(rawCreds: OAuthCredentials): string {
  // TODO(#1891 PR-3 / G5): verify Codex CLI auth.json field layout against
  // ~/.codex/auth.json on a real subscription and map Pi's blob fields
  // accordingly. Until then this is shape-unverified; the OAuth-Codex path
  // is gated upstream (no OAuth connect surface ships in PR-1).
  return JSON.stringify(rawCreds);
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
          throw new Error(
            `Provider '${provider}' (Pi backend) is API-key only; OAuth subscription delivery is not supported.`
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
