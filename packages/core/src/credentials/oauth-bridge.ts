/** Holds abortable subscription logins across start/poll requests. */
import { AnthropicCallbackPortBusyError } from './anthropic-oauth';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@archon/paths';
import type { OAuthAuthInfo, OAuthDeviceCodeInfo } from './subscription-oauth';
import {
  subscriptionOAuthProviderFor,
  SUBSCRIPTION_PROVIDERS,
  OPENAI_SUBSCRIPTION_VENDOR,
} from './oauth-providers';
import {
  createOpenAiAuthorizeFlow,
  parseOpenAiAuthorizationInput,
  exchangeOpenAiAuthorizationCode,
  type OpenAiOAuthCredentials,
} from './openai-oauth';
import {
  normalizeCredentialVendor,
  type OAuthCredentials as DeliveryOAuthCredentials,
} from './delivery';
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
const ABORT_SETTLE_MS = 1500;

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

const ABORT_MESSAGES = {
  'superseded-same-user': 'Login superseded by a newer attempt.',
  'superseded-port-conflict': 'Login superseded by a newer attempt.',
  expired: 'Login session expired.',
  cancelled: 'Login cancelled.',
  'test-reset': 'Test reset.',
};

type OAuthAbortCause =
  | { reason: Exclude<keyof typeof ABORT_MESSAGES, 'superseded-port-conflict'> }
  | { reason: 'superseded-port-conflict'; initiatedByUserId: string };

/** Internal: injected into an aborted session's manual-code deferred. */
class OAuthLoginAbortedError extends Error {
  constructor(reason: OAuthAbortCause['reason']) {
    super(ABORT_MESSAGES[reason]);
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
  sessionId: string;
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

function abortSession(session: OAuthSession, cause: OAuthAbortCause): void {
  session.abort.abort();
  session.codeDeferred.reject(new OAuthLoginAbortedError(cause.reason));
  // Log at the abort boundary: device flows and already-resolved deferreds
  // need not reject with the bridge's error, and some providers ignore aborts.
  // A connected or failed session stays mapped until polled, so a later
  // cancel/expiry/supersede still cleans it up but must not log an abort.
  if (session.status === 'pending' && cause.reason !== 'test-reset') {
    getLog().info(
      {
        userId: session.userId,
        provider: session.provider,
        sessionId: session.sessionId,
        ...cause,
      },
      'oauth_bridge.login_aborted'
    );
  }
}

/** Abort + drop expired sessions; returns their settled promises so `start` can wait. */
function sweepExpired(): Promise<void>[] {
  const now = Date.now();
  const sweptSettled: Promise<void>[] = [];
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) {
      abortSession(s, { reason: 'expired' });
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

async function runOpenAiManualLogin(session: OAuthSession): Promise<OpenAiOAuthCredentials> {
  const flow = createOpenAiAuthorizeFlow();
  session.url = flow.url;
  if (session.mode === 'pending') session.mode = 'manual';
  session.firstSignal.resolve(true);
  // Rejected by abortSession on cancel/supersede/expiry — same as manual flows.
  const input = await session.codeDeferred.promise;
  const parsed = parseOpenAiAuthorizationInput(input);
  if (parsed.state && parsed.state !== flow.state) {
    throw new Error('OAuth state mismatch.');
  }
  if (!parsed.code) {
    throw new Error('Missing authorization code.');
  }
  return exchangeOpenAiAuthorizationCode(parsed.code, flow.verifier, session.abort.signal);
}

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
  const oauthProvider =
    provider === OPENAI_SUBSCRIPTION_VENDOR ? undefined : subscriptionOAuthProviderFor(provider);
  if (provider !== OPENAI_SUBSCRIPTION_VENDOR && !oauthProvider) {
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
    const callbackPortConflict =
      oauthProvider?.usesCallbackServer === true && s.provider === provider;
    if (s.userId === userId || callbackPortConflict) {
      abortSession(
        s,
        s.userId === userId
          ? { reason: 'superseded-same-user' }
          : { reason: 'superseded-port-conflict', initiatedByUserId: userId }
      );
      supersededSettled.push(s.settled);
      sessions.delete(id);
    }
  }
  if (supersededSettled.length > 0) {
    await Promise.race([Promise.all(supersededSettled), sleep(ABORT_SETTLE_MS)]);
  }
  const sessionId = randomUUID();
  const session: OAuthSession = {
    sessionId,
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

  const loginPromise: Promise<DeliveryOAuthCredentials> = oauthProvider
    ? oauthProvider.login({
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
        // Manual providers ask for the pasted code via onManualCodeInput; route
        // that to the deferred the client submits through poll(code).
        onManualCodeInput: () => session.codeDeferred.promise,
        // Free-text/secret prompts have no interactive channel here (#2763):
        // answering with "" takes the provider's documented blank-input default
        // (github-copilot's enterprise-domain prompt defaults to github.com).
        // Routing them to codeDeferred would deadlock — poll(code) only
        // resolves once the flow reaches manual/device mode, which for
        // github-copilot happens strictly after this prompt is answered.
        onPrompt: async () => {
          getLog().info({ provider }, 'oauth_bridge.prompt_defaulted');
          return '';
        },
        // No interactive account picker on the web bridge — take the first option.
        onSelect: async prompt => prompt.options[0]?.id,
        onProgress: () => {
          getLog().debug({ provider }, 'oauth_bridge.progress');
        },
        signal: session.abort.signal,
      })
    : runOpenAiManualLogin(session);
  getLog().info({ userId, provider, sessionId, mode: session.mode }, 'oauth_bridge.login_started');
  session.settled = loginPromise
    .then(async (creds: DeliveryOAuthCredentials) => {
      await persistProviderOAuth(userId, provider, creds);
      session.status = 'connected';
      getLog().info({ userId, provider }, 'oauth_bridge.connected');
    })
    .catch((err: unknown) => {
      // An intentional cancel (supersede / expiry sweep / cancelOAuth) unwinding
      // through login is expected — don't mark error state.
      if (err instanceof OAuthLoginAbortedError || session.abort.signal.aborted) {
        session.firstSignal.resolve(true);
        return;
      }
      const rawMessage = err instanceof Error ? err.message : 'OAuth login failed.';
      if (session.status !== 'connected') {
        session.status = 'error';
        // A leaked callback server from a previous attempt (EADDRINUSE on the
        // fixed port) is retryable — classify it so start() can surface an
        // actionable error instead of an opaque failure (#1963).
        session.portBusy = err instanceof AnthropicCallbackPortBusyError;
        // Persistence errors also cross this boundary; redact before exposing them.
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
    abortSession(session, { reason: 'expired' });
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
    abortSession(session, { reason: 'cancelled' });
    sessions.delete(sessionId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Test-only: drop all in-flight sessions. */
export function resetOAuthSessionsForTest(): void {
  for (const s of sessions.values()) abortSession(s, { reason: 'test-reset' });
  sessions.clear();
}
