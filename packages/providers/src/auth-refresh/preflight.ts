import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '@archon/paths';
import { refreshIfAuthFailed } from './index.js';
import type { ClaudeCreds, CodexCreds, ProviderName, RefreshFailureReason } from './types.js';
import { buildReauthMessage, isTerminalRefreshReason } from './shared.js';

const FRESHNESS_BUFFER_MS = 60_000;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.auth-refresh.preflight');
  return cachedLog;
}

function credentialsPath(provider: ProviderName): string {
  if (provider === 'claude') return path.join(os.homedir(), '.claude', '.credentials.json');
  return path.join(os.homedir(), '.codex', 'auth.json');
}

interface FreshnessRead {
  freshExpiresAt?: number;
  hasCreds: boolean;
  hasRefreshToken: boolean;
}

function readClaudeFreshness(filePath: string): FreshnessRead {
  if (!fs.existsSync(filePath)) return { hasCreds: false, hasRefreshToken: false };
  let parsed: ClaudeCreds;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaudeCreds;
  } catch {
    return { hasCreds: true, hasRefreshToken: false };
  }
  const expiresAt = parsed.claudeAiOauth?.expiresAt;
  const refreshToken = parsed.claudeAiOauth?.refreshToken;
  const isNumber = typeof expiresAt === 'number';
  const fresh = isNumber && expiresAt > Date.now() + FRESHNESS_BUFFER_MS ? expiresAt : undefined;
  return {
    freshExpiresAt: fresh,
    hasCreds: true,
    hasRefreshToken: Boolean(refreshToken),
  };
}

function readCodexFreshness(filePath: string): FreshnessRead {
  // Codex auth.json has no explicit expiresAt; the binary handles refresh in-process
  // and stamps last_refresh. Treat tokens as fresh when last_refresh is < ~12h old
  // (matches Codex's documented ~12h access token lifetime per ChatGPT-managed auth).
  if (!fs.existsSync(filePath)) return { hasCreds: false, hasRefreshToken: false };
  let parsed: CodexCreds;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CodexCreds;
  } catch {
    return { hasCreds: true, hasRefreshToken: false };
  }
  const refreshToken = parsed.tokens?.refresh_token;
  const lastRefreshStr = parsed.last_refresh;
  const lastRefreshMs = lastRefreshStr ? new Date(lastRefreshStr).getTime() : NaN;
  const fresh =
    Number.isFinite(lastRefreshMs) && Date.now() - lastRefreshMs < 11 * 60 * 60 * 1000
      ? lastRefreshMs + 12 * 60 * 60 * 1000
      : undefined;
  return {
    freshExpiresAt: fresh,
    hasCreds: true,
    hasRefreshToken: Boolean(refreshToken),
  };
}

function readFreshness(provider: ProviderName): FreshnessRead {
  const filePath = credentialsPath(provider);
  return provider === 'claude' ? readClaudeFreshness(filePath) : readCodexFreshness(filePath);
}

/**
 * Provider-boundary proactive freshness check (Layer 2).
 *
 * Implements behavior spec v2 invariant I-1 (Token freshness on first call):
 * call this BEFORE any SDK invocation. If the on-disk access token is within
 * FRESHNESS_BUFFER_MS of expiry (or already expired), trigger the existing
 * refresh path before the subprocess pre-loads stale credentials.
 *
 * Quiet on missing creds (let the SDK surface its own clearer error). Throws
 * with re-auth instructions on terminal refresh failure so the caller can
 * surface a user-facing fail-loud message.
 */
export async function ensureFreshAuth(provider: ProviderName): Promise<void> {
  const freshness = readFreshness(provider);

  if (!freshness.hasCreds) {
    // No creds file. Let the SDK throw its own clear error rather than
    // pretending refresh is the problem.
    return;
  }

  if (freshness.freshExpiresAt !== undefined) {
    getLog().debug(
      { provider, expiresAtISO: new Date(freshness.freshExpiresAt).toISOString() },
      'provider_preflight_refresh_short_circuit_fresh'
    );
    return;
  }

  if (!freshness.hasRefreshToken) {
    // Token expired AND no refresh token to recover. Surface a terminal
    // error rather than letting the SDK try to use the dead access token.
    getLog().error({ provider, reason: 'no_refresh_token' }, 'provider_preflight_refresh_failed');
    throw new Error(buildReauthMessage(provider, 'no_refresh_token'));
  }

  getLog().info({ provider }, 'provider_preflight_refresh_attempt');

  // BDC fork: Layer 4 — for Codex only, attempt a binary-driven soft refresh
  // FIRST. OpenAI's documented pattern is "run Codex and persist the updated
  // auth.json"; calling the OAuth refresh endpoint directly is explicitly
  // discouraged. If the binary self-refreshes we skip the direct POST.
  // Research doc §Design recommendation L4.
  if (provider === 'codex') {
    try {
      // Imported lazily to keep the auth-refresh package free of codex
      // implementation imports. soft-refresh.ts lives in providers/codex/ to
      // colocate with the binary-resolver it needs.
      const { softRefreshCodex } = await import('../codex/soft-refresh.js');
      const advanced = await softRefreshCodex();
      if (advanced) {
        // Binary self-refreshed; re-read to confirm freshness and short-circuit
        const post = readFreshness('codex');
        if (post.freshExpiresAt !== undefined) {
          getLog().info({ provider: 'codex' }, 'provider_preflight_refresh_success_via_soft');
          return;
        }
      }
      getLog().info({ provider: 'codex' }, 'codex_fallback_to_direct_refresh');
    } catch (err) {
      getLog().warn({ provider: 'codex', err: (err as Error).message }, 'codex_soft_refresh_threw');
      // Fall through to direct refresh below.
    }
  }

  const result = await refreshIfAuthFailed(provider);

  if (result.refreshed) {
    getLog().info(
      { provider, newExpiresAtISO: new Date(result.expiresAt).toISOString() },
      'provider_preflight_refresh_success'
    );
    return;
  }

  const reason: RefreshFailureReason = result.reason;
  if (isTerminalRefreshReason(reason)) {
    getLog().error({ provider, reason }, 'provider_preflight_refresh_failed_terminal');
    throw new Error(buildReauthMessage(provider, reason));
  }

  // Non-terminal refresh failure (network, unknown, 5xx). The SDK might
  // succeed anyway if the existing token has a few seconds of life left,
  // and the reactive refresh path (PR #48) still covers the catch case.
  getLog().warn({ provider, reason }, 'provider_preflight_refresh_failed_transient');
}
