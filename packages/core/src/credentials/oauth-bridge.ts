/**
 * Non-blocking subscription-login bridge over Pi's `provider.login(callbacks)`.
 *
 * Unlike the GitHub device flow (stateless poll-once against GitHub's API),
 * Pi's `login()` is ONE long-lived call that blocks on its callbacks. So the
 * bridge holds the in-flight `login()` promise in a server-side session and
 * feeds it through `start` → `poll(code?)`:
 *
 *   - **manual-code** (Anthropic / OpenAI-Codex): `login()` fires `onAuth(url)`;
 *     the user authorizes in a browser and gets a code; the client submits it via
 *     `poll(code)`, which resolves the callback Pi is awaiting; `login()` then
 *     completes and we persist.
 *   - **device-code** (GitHub Copilot): `login()` fires `onDeviceCode(userCode,
 *     verificationUri)` and polls internally; the bridge just waits for `login()`
 *     to resolve.
 *
 * Sessions are bound to `userId`, short-TTL, and abortable; credentials are never
 * logged. GOTCHA (verify on a live run): Anthropic/Codex `login()` may also try a
 * localhost callback server (`usesCallbackServer`) — on a headless host the
 * manual-code path (`onManualCodeInput`/`onPrompt`) must be the one taken.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@archon/paths';
import type {
  OAuthCredentials as PiOAuthCredentials,
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
} from '@archon/providers/oauth';
import { piOAuthProviderFor, SUBSCRIPTION_PROVIDERS } from './oauth-providers';
import { persistProviderOAuth } from './connect-service';
import { sanitizeCredentials, sanitizeError } from '../utils/credential-sanitizer';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('credentials.oauth-bridge');
  return cachedLog;
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** How long `start` waits for the first onAuth/onDeviceCode callback before returning. */
const START_FIRST_SIGNAL_MS = 8000;

type OAuthMode = 'manual' | 'device' | 'pending';
type OAuthStatus = 'pending' | 'connected' | 'error';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

interface OAuthSession {
  userId: string;
  provider: string;
  mode: OAuthMode;
  url?: string;
  userCode?: string;
  verificationUri?: string;
  status: OAuthStatus;
  detail?: string;
  codeSubmitted: boolean;
  codeDeferred: Deferred<string>;
  firstSignal: Deferred<true>;
  abort: AbortController;
  expiresAt: number;
}

const sessions = new Map<string, OAuthSession>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) {
      s.abort.abort();
      sessions.delete(id);
    }
  }
}

/** Internal `'pending'` never surfaces past the boundary — default it to `'manual'`. */
function externalMode(session: OAuthSession): 'manual' | 'device' {
  return session.mode === 'device' ? 'device' : 'manual';
}

export interface StartOAuthResult {
  sessionId: string;
  mode: 'manual' | 'device';
  url?: string;
  userCode?: string;
  verificationUri?: string;
  expiresIn: number;
}

export interface PollOAuthResult {
  status: OAuthStatus;
  detail?: string;
  mode?: 'manual' | 'device';
  url?: string;
  userCode?: string;
  verificationUri?: string;
}

/**
 * Begin a subscription login for `provider` (claude/codex/copilot). Kicks off
 * Pi's `login()` (held server-side) and returns once the first callback has
 * populated the URL (manual) or user-code (device), or a short timeout elapses.
 */
export async function startOAuth(userId: string, provider: string): Promise<StartOAuthResult> {
  sweepExpired();
  // SUBSCRIPTION_PROVIDERS is the single source of truth for "connectable via
  // subscription" — it excludes providers that are wired in ARCHON_TO_PI_OAUTH
  // (so delivery/refresh still work) but gated off because the flow isn't usable
  // end-to-end (e.g. codex: Pi drops the id_token, #1924). Gate here too so the
  // bridge can't be driven past the route/CLI check.
  const piProvider = SUBSCRIPTION_PROVIDERS.has(provider)
    ? piOAuthProviderFor(provider)
    : undefined;
  if (!piProvider) {
    throw new Error(`Provider '${provider}' does not support subscription login.`);
  }
  // One in-flight login per user — abort a prior session so its callback server
  // (claude/codex `usesCallbackServer`) is released; otherwise a fixed-port flow
  // would EADDRINUSE a retry of the same user.
  for (const [id, s] of sessions) {
    if (s.userId === userId) {
      s.abort.abort();
      sessions.delete(id);
    }
  }
  const sessionId = randomUUID();
  const session: OAuthSession = {
    userId,
    provider,
    mode: 'pending',
    status: 'pending',
    codeSubmitted: false,
    codeDeferred: deferred<string>(),
    firstSignal: deferred<true>(),
    abort: new AbortController(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(sessionId, session);

  // Kick off login() WITHOUT awaiting — it blocks on the callbacks below.
  void piProvider
    .login({
      onAuth: (info: OAuthAuthInfo) => {
        session.url = info.url;
        if (session.mode === 'pending') session.mode = 'manual';
        session.firstSignal.resolve(true);
      },
      onDeviceCode: (info: OAuthDeviceCodeInfo) => {
        session.userCode = info.userCode;
        session.verificationUri = info.verificationUri;
        session.mode = 'device';
        session.firstSignal.resolve(true);
      },
      // Manual providers ask for the pasted code via onManualCodeInput (or onPrompt);
      // wire both to the same deferred. NOTE: a future provider that used onPrompt for
      // a DIFFERENT question would get handed the auth code — fine for claude/codex/copilot.
      onManualCodeInput: () => session.codeDeferred.promise,
      onPrompt: async () => session.codeDeferred.promise,
      // No interactive account picker on the web bridge — take the first option.
      onSelect: async prompt => prompt.options[0]?.id,
      onProgress: (message: string) => {
        getLog().debug({ provider, message }, 'oauth_bridge.progress');
      },
      signal: session.abort.signal,
    })
    .then(async (creds: PiOAuthCredentials) => {
      await persistProviderOAuth(userId, provider, creds);
      session.status = 'connected';
      getLog().info({ userId, provider }, 'oauth_bridge.connected');
    })
    .catch((err: unknown) => {
      if (session.status !== 'connected') {
        session.status = 'error';
        // Genericize/strip secrets before this can reach a client: Pi's OAuth errors
        // embed auth-endpoint URLs / HTTP response bodies (login bypasses the
        // getOAuthApiKey wrapper). Truncate too (I4).
        session.detail = sanitizeCredentials(
          err instanceof Error ? err.message : 'OAuth login failed.'
        ).slice(0, 200);
      }
      // Unblock start()'s race on an early failure (rejection before any callback),
      // so it doesn't wait the full timeout then return a bogus url-less result (I1).
      session.firstSignal.resolve(true);
      getLog().warn(
        { err: sanitizeError(err as Error), userId, provider },
        'oauth_bridge.login_failed'
      );
    });

  // Wait for the first callback so the URL / user-code is available to return.
  await Promise.race([session.firstSignal.promise, sleep(START_FIRST_SIGNAL_MS)]);

  // An early login() failure → throw (route returns 500, CLI prints the message)
  // rather than returning a misleading { mode:'manual', url:undefined } (I1).
  if (session.status === 'error') {
    sessions.delete(sessionId);
    throw new Error(session.detail ?? 'Subscription login failed to start.');
  }

  return {
    sessionId,
    mode: externalMode(session),
    url: session.url,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    expiresIn: Math.round(SESSION_TTL_MS / 1000),
  };
}

/**
 * Poll a login session. For manual-code flows, pass the user's pasted `code`
 * (once) to unblock `login()`. Returns `connected` (and clears the session) on
 * success, `error` on failure/expiry, else `pending`.
 */
export function pollOAuth(sessionId: string, userId: string, code?: string): PollOAuthResult {
  sweepExpired(); // I3: don't leave abandoned sessions (and their callback servers) holding on
  const session = sessions.get(sessionId);
  if (session?.userId !== userId) {
    return { status: 'error', detail: 'Login session not found or expired.' };
  }
  if (Date.now() > session.expiresAt) {
    session.abort.abort();
    sessions.delete(sessionId);
    return { status: 'error', detail: 'Login session expired.' };
  }
  if (code && session.mode === 'manual' && !session.codeSubmitted) {
    session.codeSubmitted = true;
    session.codeDeferred.resolve(code.trim());
  }
  if (session.status === 'connected') {
    sessions.delete(sessionId);
    return { status: 'connected' };
  }
  if (session.status === 'error') {
    sessions.delete(sessionId);
    return { status: 'error', detail: session.detail };
  }
  return {
    status: 'pending',
    mode: externalMode(session),
    url: session.url,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
  };
}

/** Cancel + drop a login session (best-effort). */
export function cancelOAuth(sessionId: string, userId: string): void {
  const session = sessions.get(sessionId);
  if (session?.userId === userId) {
    session.abort.abort();
    sessions.delete(sessionId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Test-only: drop all in-flight sessions. */
export function resetOAuthSessionsForTest(): void {
  for (const s of sessions.values()) s.abort.abort();
  sessions.clear();
}
