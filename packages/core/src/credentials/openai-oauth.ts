/**
 * Archon-OWNED OpenAI (ChatGPT/Codex subscription) OAuth flow (#1924).
 *
 * Why not Pi's `openaiCodexOAuthProvider`: pi-ai (verified through 0.79.1,
 * `dist/utils/oauth/openai-codex.js` `readTokenResponse`) keeps only
 * `{ access, refresh, expires }` from the token response and DROPS the
 * `id_token` — but the Codex CLI requires a real `id_token` JWT in
 * `CODEX_HOME/auth.json` and crashes with "invalid ID token format" on an
 * empty one. Owning the exchange (and refresh) lets Archon capture and
 * preserve the full credential.
 *
 * This is the Codex CLI's own public OAuth client (PKCE, no client secret),
 * so the minted tokens are exactly what the native Codex runtime accepts.
 * The authorize-URL construction mirrors Pi's byte-for-byte (same client id,
 * scope, redirect URI, `id_token_add_organizations` + simplified-flow params,
 * `originator=pi`) because that exact construction is the one verified
 * working end-to-end on the #1924 live smoke — only the client-side handling
 * of the response differs.
 *
 * DELIBERATELY manual-paste only: there is NO server-side callback listener.
 * Binding a local fixed-port callback server from a long-lived multi-user
 * process is exactly the wedge pattern of #1963 (an abandoned login holds the
 * port install-wide); the user authorizes in a browser and pastes the
 * redirect URL / code back through the bridge's poll instead.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthCredentials } from './delivery';

/** The Codex CLI's public OAuth client id (PKCE — no secret involved). */
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_SCOPE = 'openid profile email offline_access';
/**
 * Registered redirect URI of the Codex CLI client. Nothing listens on it in
 * Archon (see header) — the user copies the final redirect URL (or just the
 * code) from the browser and pastes it back.
 */
const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback';
/** JWT claim object carrying the ChatGPT account id (mirrors Pi). */
const OPENAI_JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/**
 * The OpenAI subscription credential blob Archon stores. Superset of Pi's
 * `{ access, refresh, expires, accountId }` shape (delivery to Pi's auth.json
 * tolerates the extra field — Pi's `OAuthCredentials` is index-signature
 * open), plus the `id_token` the Codex CLI requires.
 */
export interface OpenAiOAuthCredentials {
  access: string;
  refresh: string;
  /** Epoch ms expiry of the access token. */
  expires: number;
  /** ChatGPT account id derived from the access-token JWT claim. */
  accountId: string;
  /** The OpenID id_token — required verbatim by the Codex CLI's auth.json. */
  id_token: string;
  [key: string]: unknown;
}

/** An authorize URL plus the per-attempt secrets needed to finish the flow. */
export interface OpenAiAuthorizeFlow {
  url: string;
  /** PKCE code verifier (kept server-side; never shown to the user). */
  verifier: string;
  /** CSRF state parameter — checked against the pasted redirect URL. */
  state: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Build the authorize URL with fresh PKCE (S256) + state material. */
export function createOpenAiAuthorizeFlow(): OpenAiAuthorizeFlow {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = randomBytes(16).toString('hex');
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_CLIENT_ID);
  url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI);
  url.searchParams.set('scope', OPENAI_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // Asks OpenAI to embed organization/account info in the id_token (Pi sets
  // this too); the Codex CLI reads those claims.
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'pi');
  return { url: url.toString(), verifier, state };
}

/**
 * Parse the user's pasted authorization input — full redirect URL, bare code,
 * `code#state`, or a `code=...&state=...` query fragment. Mirrors Pi's
 * `parseAuthorizationInput` leniency so the paste UX matches the other
 * manual-code flows.
 */
export function parseOpenAiAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Extract the ChatGPT account id from an access-token JWT, or null. */
function accountIdFromAccessToken(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[OPENAI_JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

interface OpenAiTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

async function postTokenRequest(
  body: URLSearchParams,
  operation: 'exchange' | 'refresh',
  signal?: AbortSignal
): Promise<OpenAiTokenResponse> {
  let response: Response;
  try {
    response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      // The 30s ceiling applies ALWAYS — combined with the caller's session
      // signal when present. Without it, a hung token endpoint would leave a
      // bridge login reporting `pending` for the session's full 10-minute TTL.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('Login cancelled');
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`OpenAI token ${operation} request timed out.`);
    }
    throw new Error(
      `OpenAI token ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    // Strip the error body down to the OAuth `error` code: this message flows
    // into the bridge's session.detail (and on to the browser/CLI), and OpenAI
    // error bodies can carry account identifiers. Never include the raw body.
    const text = await response.text().catch(() => '');
    let errorCode = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') {
        errorCode = parsed.error;
      } else if (parsed.error && typeof parsed.error === 'object') {
        const code = (parsed.error as { code?: unknown }).code;
        if (typeof code === 'string') errorCode = code;
      }
    } catch {
      // Non-JSON error body — drop it entirely; the status code must suffice.
    }
    throw new Error(
      `OpenAI token ${operation} failed (${response.status})${errorCode ? `: ${errorCode}` : ''}`
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    // An HTTP 200 with a non-JSON body (proxy/maintenance page) must surface
    // as a labeled error, not a raw SyntaxError mistaken for an Archon bug.
    throw new Error(
      `OpenAI token ${operation} returned a non-JSON response (HTTP ${response.status}).`
    );
  }
  return raw as OpenAiTokenResponse;
}

/**
 * Map a token response onto the stored credential blob. Fails loud on a
 * missing `id_token` at exchange time (the whole point of owning this flow);
 * on refresh, a response that omits `id_token`/`refresh_token` PRESERVES the
 * previous values instead of degrading the blob.
 */
function credentialsFromTokenResponse(
  json: OpenAiTokenResponse,
  operation: 'exchange' | 'refresh',
  previous?: OAuthCredentials
): OpenAiOAuthCredentials {
  const access = typeof json.access_token === 'string' ? json.access_token : '';
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : NaN;
  if (!access || !Number.isFinite(expiresIn)) {
    throw new Error(`OpenAI token ${operation} response missing access_token/expires_in.`);
  }
  const prevRefresh = typeof previous?.refresh === 'string' ? previous.refresh : '';
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : prevRefresh;
  if (!refresh) {
    throw new Error(`OpenAI token ${operation} response missing refresh_token.`);
  }
  const prevIdToken = typeof previous?.id_token === 'string' ? previous.id_token : '';
  const idToken = typeof json.id_token === 'string' && json.id_token ? json.id_token : prevIdToken;
  if (!idToken) {
    // Fail loud: an id_token-less credential reproduces the exact #1924
    // breakage ("invalid ID token format" in the Codex CLI) — never store one.
    throw new Error(
      `OpenAI token ${operation} response did not include an id_token (required by the Codex CLI).`
    );
  }
  const prevAccountId = typeof previous?.accountId === 'string' ? previous.accountId : '';
  const accountId = accountIdFromAccessToken(access) ?? prevAccountId;
  if (!accountId) {
    throw new Error('Failed to extract the ChatGPT account id from the OpenAI access token.');
  }
  return {
    // Preserve any extra fields a future token response taught us to keep.
    ...(previous ?? {}),
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    accountId,
    id_token: idToken,
  };
}

/**
 * Exchange a pasted authorization code for the full credential blob
 * (access/refresh/expiry, ChatGPT account id, and — unlike Pi — the
 * `id_token`). Throws with a descriptive message on any missing field.
 */
export async function exchangeOpenAiAuthorizationCode(
  code: string,
  verifier: string,
  signal?: AbortSignal
): Promise<OpenAiOAuthCredentials> {
  const json = await postTokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_REDIRECT_URI,
    }),
    'exchange',
    signal
  );
  return credentialsFromTokenResponse(json, 'exchange');
}

/**
 * Refresh an OpenAI subscription credential directly (same public client id).
 * Preserves `id_token` (and `refresh`) when the refresh response omits them —
 * the reason this does NOT go through Pi's `getOAuthApiKey`, which would
 * rebuild the blob from scratch and drop the id_token on every rotation.
 */
export async function refreshOpenAiOAuthCredentials(
  creds: OAuthCredentials
): Promise<OpenAiOAuthCredentials> {
  const refresh = typeof creds.refresh === 'string' ? creds.refresh : '';
  if (!refresh) {
    throw new Error('Stored OpenAI credential has no refresh token.');
  }
  const json = await postTokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CLIENT_ID,
      refresh_token: refresh,
    }),
    'refresh'
  );
  return credentialsFromTokenResponse(json, 'refresh', creds);
}

/**
 * Mint a usable bearer from a stored OpenAI credential blob, refreshing first
 * when expired. Same contract as Pi's `getOAuthApiKey` (`{ newCredentials,
 * apiKey } | null`) so the store's shared rotation/resave logic applies
 * unchanged. Throws when a needed refresh fails.
 *
 * Accepts the narrow {@link OpenAiOAuthCredentials} so the compiler enforces
 * the vendor routing (only openai blobs reach this path). The runtime guards
 * stay anyway: stored rows are decrypted JSON, so the static shape is a
 * write-time promise, not a read-time guarantee.
 */
export async function mintOpenAiOAuthApiKey(
  creds: OpenAiOAuthCredentials
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  let current: OAuthCredentials = creds;
  if (typeof creds.expires === 'number' && Date.now() >= creds.expires) {
    current = await refreshOpenAiOAuthCredentials(creds);
  }
  const access = typeof current.access === 'string' ? current.access : '';
  if (!access) return null;
  return { newCredentials: current, apiKey: access };
}
