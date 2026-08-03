/**
 * Non-blocking subscription-login bridge over Pi's `provider.login(callbacks)`.
 *
 * Unlike the GitHub device flow (stateless poll-once against GitHub's API),
 * Pi's `login()` is ONE long-lived call that blocks on its callbacks. So the
 * bridge holds the in-flight `login()` promise in a server-side session and
 * feeds it through `start` → `poll(code?)`:
 *
 *   - **manual-code** (Anthropic via Pi; OpenAI/ChatGPT via the Archon-owned
 *     PKCE flow in `openai-oauth.ts`, #1924): the flow surfaces an authorize
 *     URL; the user authorizes in a browser and gets a code; the client submits
 *     it via `poll(code)`, which resolves the deferred the flow is awaiting;
 *     the login then completes and we persist.
 *   - **device-code** (GitHub Copilot): `login()` fires `onDeviceCode(userCode,
 *     verificationUri)` and polls internally; the bridge just waits for `login()`
 *     to resolve.
 *
 * Sessions are bound to `userId`, short-TTL, and abortable; credentials are never
 * logged. On a headless host the callback-server flows must complete via the
 * manual-code path (`onManualCodeInput`/`onPrompt`) — nothing can reach their
 * localhost callback server (see CANCEL SEMANTICS for the abort side of this).
 *
 * CANCEL SEMANTICS (#1963): pi-ai 0.79.1 ignores `options.signal` in its
 * CALLBACK-SERVER login flows — `loginAnthropic` never reads it (verified
 * against `dist/utils/oauth/anthropic.js`; the provider's `login()` doesn't
 * even forward the signal) and `loginOpenAICodex`'s browser flow never closes
 * its server on abort. (`loginGitHubCopilot`, device-code, DOES honor
 * `callbacks.signal` — the narrow claim matters if you add a provider.) So
 * aborting the AbortController alone leaks the fixed-port callback server
 * forever — each flow binds its own fixed port (anthropic 53692, openai-codex
 * 1455), which is also why the supersede logic below keys on provider
 * identity — and wedges every later login for that vendor install-wide. The
 * one cancel handle pi exposes is the `onManualCodeInput()` promise: when it
 * REJECTS, pi's login calls `server.cancelWait()`, unblocks `waitForCode()`,
 * rethrows, and runs `finally { server.close() }` — releasing the port.
 * `abortSession` therefore rejects the bridge-owned `codeDeferred` in
 * addition to firing the abort signal, and `startOAuth` waits (bounded) for
 * superseded logins to settle before binding a new one.
 *
 * Upstream fix requested: https://github.com/earendil-works/pi/issues/5649
 * (honor `options.signal` / bind an ephemeral port). Re-evaluate the
 * deferred-rejection workaround when that lands.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@archon/paths';
import type {
  OAuthCredentials as PiOAuthCredentials,
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
} from '@archon/providers/oauth';
import {
  piOAuthProviderFor,
  SUBSCRIPTION_PROVIDERS,
  OPENAI_SUBSCRIPTION_VENDOR,
} from './oauth-providers';
import {
  createOpenAiAuthorizeFlow,
  parseOpenAiAuthorizationInput,
  exchangeOpenAiAuthorizationCode,
  type OpenAiOAuthCredentials,
} from './openai-oauth';
import { normalizeCredentialVendor } from './delivery';
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
/**
 * How long `start` waits for superseded logins to settle (i.e. pi's
 * `finally { server.close() }` to run) before binding the new login's callback
 * server. Real unwinds settle in microtasks; this bound only matters for a
 * login impl that ignores the cancel entirely — it then costs one wait and the
 * port-busy classification below turns any residual collision into an
 * actionable error instead of a permanent wedge.
 */
const ABORT_SETTLE_MS = 1500;

/** Matches the failure modes of a leaked fixed-port callback server. */
const PORT_BUSY_RE = /EADDRINUSE|address already in use|is port .+ in use/i;

/**
 * A subscription-login start failed because the OAuth callback port is still
 * held (a previous attempt's callback server has not released it yet). Mapped
 * to a 503 by the API route — retryable, unlike an opaque 500.
 */
export class OAuthCallbackPortBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCallbackPortBusyError';
  }
}

/** Internal: injected into an aborted session's manual-code deferred (see header). */
class OAuthLoginAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthLoginAbortedError';
  }
}

type OAuthMode = 'manual' | 'device' | 'pending';
type OAuthStatus = 'pending' | 'connected' | 'error';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  /**
   * Resolves when the held `login()` call has settled. Never rejects: it is
   * the full `.then().catch()` chain built in `startOAuth`, whose terminal
   * `.catch()` swallows every failure into session state.
   */
  settled: Promise<void>;
  /** Set when `login()` failed because the callback port was already bound. */
  portBusy?: boolean;
}

const sessions = new Map<string, OAuthSession>();

/**
 * Hard-cancel a session's in-flight `login()`: fire the abort signal (honored
 * by the device-code flow) AND reject the manual-code deferred — the only
 * handle pi-ai 0.79.1's callback-server flows actually react to. The rejection
 * drives those flows through their error path into `finally { server.close() }`,
 * releasing the flow's fixed callback port (anthropic 53692, openai-codex
 * 1455; #1963). Rejecting an already-resolved deferred is a no-op, so this is
 * safe after a code was submitted.
 */
function abortSession(session: OAuthSession, reason: string): void {
  session.abort.abort();
  session.codeDeferred.reject(new OAuthLoginAbortedError(reason));
}

/** Abort + drop expired sessions; returns their settled promises so `start` can wait. */
function sweepExpired(): Promise<void>[] {
  const now = Date.now();
  const sweptSettled: Promise<void>[] = [];
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) {
      abortSession(s, 'Login session expired.');
      sweptSettled.push(s.settled);
      sessions.delete(id);
    }
  }
  return sweptSettled;
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
 * The Archon-owned ChatGPT/Codex manual login (#1924): build the authorize
 * URL (PKCE), surface it on the session, wait for the pasted redirect URL /
 * code via the same `codeDeferred` the Pi manual flows use (so poll(code) and
 * abort semantics are identical), then exchange it directly — capturing the
 * `id_token` Pi drops. Runs NO local callback server (the #1963 wedge
 * pattern); the user pastes the final redirect URL or code back instead.
 */
async function runOpenAiManualLogin(session: OAuthSession): Promise<OpenAiOAuthCredentials> {
  const flow = createOpenAiAuthorizeFlow();
  session.url = flow.url;
  if (session.mode === 'pending') session.mode = 'manual';
  session.firstSignal.resolve(true);
  // Rejected by abortSession on cancel/supersede/expiry — same as Pi flows.
  const input = await session.codeDeferred.promise;
  const parsed = parseOpenAiAuthorizationInput(input);
  if (parsed.state && parsed.state !== flow.state) {
    throw new Error('OAuth state mismatch.');
  }
  if (!parsed.code) {
    throw new Error('Missing authorization code.');
  }
  // Returns its true type — structurally assignable to PiOAuthCredentials
  // (access/refresh/expires plus extras), so no cast at the loginPromise join.
  return exchangeOpenAiAuthorizationCode(parsed.code, flow.verifier, session.abort.signal);
}

/**
 * Begin a subscription login for a vendor (anthropic/openai/github-copilot;
 * legacy claude/codex/copilot ids accepted). Kicks off the held login —
 * Pi's `login()` for anthropic/github-copilot, the Archon-owned PKCE flow for
 * openai — and returns once the first signal has populated the URL (manual)
 * or user-code (device), or a short timeout elapses.
 */
export async function startOAuth(userId: string, providerId: string): Promise<StartOAuthResult> {
  // Expired sessions may also hold a callback server — include them in the
  // settle-wait below so the port is free before the new login binds it.
  const supersededSettled: Promise<void>[] = sweepExpired();
  const provider = normalizeCredentialVendor(providerId);
  // SUBSCRIPTION_PROVIDERS is the single source of truth for "connectable via
  // subscription". Gate here too so the bridge can't be driven past the
  // route/CLI check.
  if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
    throw new Error(`Provider '${providerId}' does not support subscription login.`);
  }
  // `openai` (ChatGPT/Codex) runs the Archon-OWNED PKCE flow (openai-oauth.ts)
  // instead of Pi's: Pi drops the id_token the Codex CLI requires (#1924), and
  // Pi's flow would also bind a local fixed-port callback server — the #1963
  // wedge pattern this bridge just escaped. piProvider stays undefined for it.
  const piProvider =
    provider === OPENAI_SUBSCRIPTION_VENDOR ? undefined : piOAuthProviderFor(provider);
  if (provider !== OPENAI_SUBSCRIPTION_VENDOR && !piProvider) {
    throw new Error(`Provider '${providerId}' does not support subscription login.`);
  }
  // Hard-cancel prior in-flight logins that would collide with this one:
  //   - same user (one login per user — the original I3 behavior), and
  //   - same vendor when the flow binds a local fixed-port callback server
  //     (anthropic: 53692). Two such logins can't coexist in one process, and
  //     an abandoned one would otherwise EADDRINUSE every later start for ANY
  //     user until restart (#1963). The newest interactive request wins; a
  //     superseded session's user sees "session not found" on their next poll
  //     and can simply restart — recoverable, so the heuristic is acceptable.
  for (const [id, s] of sessions) {
    const callbackPortConflict = piProvider?.usesCallbackServer === true && s.provider === provider;
    if (s.userId === userId || callbackPortConflict) {
      abortSession(s, 'Login superseded by a newer attempt.');
      supersededSettled.push(s.settled);
      sessions.delete(id);
    }
  }
  // Wait (bounded) for the cancelled logins to settle — settling means pi's
  // `finally { server.close() }` has run, so the callback port is free before
  // the new login binds it.
  if (supersededSettled.length > 0) {
    await Promise.race([Promise.all(supersededSettled), sleep(ABORT_SETTLE_MS)]);
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
    settled: Promise.resolve(), // replaced with the real login chain below
  };
  // Device flows never consume the manual-code deferred — keep its abort-path
  // rejection from surfacing as an unhandled rejection.
  session.codeDeferred.promise.catch(() => undefined);
  sessions.set(sessionId, session);

  // Kick off the login WITHOUT awaiting — it blocks on the callbacks/deferred.
  const loginPromise: Promise<PiOAuthCredentials> = piProvider
    ? piProvider.login({
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
        // a DIFFERENT question would get handed the auth code — fine for claude/copilot.
        onManualCodeInput: () => session.codeDeferred.promise,
        onPrompt: async () => session.codeDeferred.promise,
        // No interactive account picker on the web bridge — take the first option.
        onSelect: async prompt => prompt.options[0]?.id,
        onProgress: (message: string) => {
          getLog().debug({ provider, message }, 'oauth_bridge.progress');
        },
        signal: session.abort.signal,
      })
    : runOpenAiManualLogin(session);
  session.settled = loginPromise
    .then(async (creds: PiOAuthCredentials) => {
      await persistProviderOAuth(userId, provider, creds);
      session.status = 'connected';
      getLog().info({ userId, provider }, 'oauth_bridge.connected');
    })
    .catch((err: unknown) => {
      // An intentional cancel (supersede / expiry sweep / cancelOAuth) unwinding
      // through pi's login is expected — log quietly and don't mark error state.
      if (err instanceof OAuthLoginAbortedError) {
        session.firstSignal.resolve(true);
        getLog().info({ userId, provider }, 'oauth_bridge.login_aborted');
        return;
      }
      const rawMessage = err instanceof Error ? err.message : 'OAuth login failed.';
      if (session.status !== 'connected') {
        session.status = 'error';
        // A leaked callback server from a previous attempt (EADDRINUSE on the
        // fixed port) is retryable — classify it so start() can surface an
        // actionable error instead of an opaque failure (#1963).
        session.portBusy = PORT_BUSY_RE.test(rawMessage);
        // Genericize/strip secrets before this can reach a client: Pi's OAuth errors
        // embed auth-endpoint URLs / HTTP response bodies (login bypasses the
        // getOAuthApiKey wrapper). Truncate too (I4).
        session.detail = sanitizeCredentials(rawMessage).slice(0, 200);
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
    if (session.portBusy) {
      // Retryable: the cancel above releases the port as soon as the previous
      // login unwinds (microtasks for pi flows), so "retry shortly" is honest
      // advice — and a restart always clears it (#1963).
      throw new OAuthCallbackPortBusyError(
        `A previous '${provider}' login attempt is still holding the OAuth callback port. ` +
          'Wait a few seconds and retry; if it persists, restart the Archon server.'
      );
    }
    throw new Error(session.detail ?? 'Subscription login failed to start.');
  }

  // Superseded (or cancelled) while still waiting for the first signal — the
  // session is already gone from the map, so a 200 here would hand back a
  // url-less session the first poll immediately reports as "not found".
  // Throw the honest answer instead (S4).
  if (!sessions.has(sessionId)) {
    throw new Error('Login attempt was superseded by a newer one. Retry to start a fresh login.');
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
  // I3: don't leave abandoned sessions (and their callback servers) holding on.
  // `void`: poll has no reason to await port release — only `start` (which is
  // about to bind the port) waits on the swept sessions' settle promises.
  void sweepExpired();
  const session = sessions.get(sessionId);
  if (session?.userId !== userId) {
    return { status: 'error', detail: 'Login session not found or expired.' };
  }
  if (Date.now() > session.expiresAt) {
    abortSession(session, 'Login session expired.');
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
    abortSession(session, 'Login cancelled.');
    sessions.delete(sessionId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Test-only: drop all in-flight sessions. */
export function resetOAuthSessionsForTest(): void {
  for (const s of sessions.values()) abortSession(s, 'Test reset.');
  sessions.clear();
}
