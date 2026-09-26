import { createHash } from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ProviderCodexRateLimitRequest, ProviderCodexRateLimitSnapshot } from '../types';
import { parseCodexConfig } from './config';
import { resolveCodexBinaryPath } from './binary-resolver';

const CODEX_RATE_LIMIT_TTL_MS = 30_000;
const CODEX_RATE_LIMIT_TIMEOUT_MS = 5_000;
const MAX_CODEX_RATE_LIMIT_CACHE = 128;
const MAX_CODEX_RATE_LIMIT_READS = 4;
const CODEX_IDENTITY_ENV_KEYS = new Set([
  'CODEX_HOME',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ID_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'CODEX_REFRESH_TOKEN',
  'CODEX_ACCOUNT_ID',
]);
const KNOWN_RATE_LIMIT_REACHED_TYPES = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

type JsonRecord = Record<string, unknown>;

interface JsonRpcResult {
  result?: unknown;
  error?: unknown;
}

type CodexAppServerProcess = ChildProcessByStdio<Writable, Readable, null>;

const codexRateLimitCache = new Map<
  string,
  { snapshot: ProviderCodexRateLimitSnapshot; expiresAt: number }
>();
const codexRateLimitReads = new Map<string, Promise<ProviderCodexRateLimitSnapshot | undefined>>();
let codexRateLimitCacheGeneration = 0;

/** Invalidate snapshots as soon as a Codex execution starts. */
export function invalidateCodexRateLimitCache(): void {
  codexRateLimitCacheGeneration += 1;
  codexRateLimitCache.clear();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codexTokenFingerprint(authJson: string): string | undefined {
  try {
    const parsed = JSON.parse(authJson) as { tokens?: JsonRecord };
    const access = parsed.tokens?.access_token;
    const refresh = parsed.tokens?.refresh_token;
    if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
      return undefined;
    }
    return createHash('sha256').update(`${access}\0${refresh}`).digest('hex');
  } catch {
    return undefined;
  }
}

async function waitForExitOrDelay(exitPromise: Promise<void>, delayMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exitPromise,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, delayMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveAppServerCommand(
  configCodexBinaryPath: string | undefined
): Promise<{ command: string; args: string[] } | undefined> {
  const explicitOrInstalled = await resolveCodexBinaryPath(configCodexBinaryPath);
  if (explicitOrInstalled) {
    if (explicitOrInstalled.endsWith('.js')) {
      return { command: process.execPath, args: [explicitOrInstalled] };
    }
    // A .cmd shim requires a shell on Windows. Do not add shell parsing to a
    // credential-sensitive subprocess; usage stays unknown on that install.
    if (process.platform === 'win32' && explicitOrInstalled.toLowerCase().endsWith('.cmd')) {
      return undefined;
    }
    return { command: explicitOrInstalled, args: [] };
  }

  try {
    const sdkEntry = import.meta.resolve('@openai/codex-sdk');
    const sdkRequire = createRequire(sdkEntry);
    const cliScript = sdkRequire.resolve('@openai/codex/bin/codex.js');
    return { command: process.execPath, args: [cliScript] };
  } catch {
    return undefined;
  }
}

function rpcRequest(
  child: CodexAppServerProcess,
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>,
  id: number,
  method: string,
  params?: JsonRecord
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Codex App Server request timed out.'));
    }, CODEX_RATE_LIMIT_TIMEOUT_MS);
    pending.set(id, {
      resolve: value => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    } catch {
      clearTimeout(timeout);
      pending.delete(id);
      reject(new Error('Codex App Server request could not be written.'));
    }
  });
}

async function readCodexRateLimitFromAppServer(
  request: ProviderCodexRateLimitRequest,
  codexHome: string,
  configCodexBinaryPath: string | undefined,
  generationAtStart: number
): Promise<ProviderCodexRateLimitSnapshot | undefined> {
  const command = await resolveAppServerCommand(configCodexBinaryPath);
  if (!command) return undefined;

  const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...(request.options?.env ?? {}) }).filter(
      ([key, value]) => value !== undefined && !CODEX_IDENTITY_ENV_KEYS.has(key)
    )
  );
  // This subprocess must authenticate only from the actor's explicit profile.
  // API-key and ambient-home auth would query a different execution identity.
  childEnv.CODEX_HOME = codexHome;

  const child = spawn(command.command, [...command.args, 'app-server', '--listen', 'stdio://'], {
    cwd: request.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  let exited = false;
  const exitPromise = new Promise<void>(resolve => {
    child.once('exit', () => {
      exited = true;
      resolve();
      for (const item of pending.values()) item.reject(new Error('Codex App Server exited.'));
      pending.clear();
    });
    child.once('error', () => {
      exited = true;
      resolve();
      for (const item of pending.values())
        item.reject(new Error('Codex App Server failed to start.'));
      pending.clear();
    });
  });
  lines.on('line', line => {
    if (line.length > 128 * 1024) {
      for (const item of pending.values())
        item.reject(new Error('Codex App Server response was too large.'));
      pending.clear();
      child.kill('SIGTERM');
      return;
    }
    let message: JsonRpcResult & { id?: unknown };
    try {
      message = JSON.parse(line) as JsonRpcResult & { id?: unknown };
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error !== undefined) item.reject(new Error('Codex App Server returned an error.'));
    else item.resolve(message.result);
  });

  try {
    await rpcRequest(child, pending, 1, 'initialize', {
      clientInfo: { name: 'archon', title: 'Archon', version: '0.11.0' },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const response = await rpcRequest(child, pending, 2, 'account/rateLimits/read');
    if (!isRecord(response)) return undefined;
    // This response field can be null/omitted in the schema. Without an exact
    // match there is no proof the read belongs to this direct-chat identity.
    if (response.accountId !== request.expectedAccountId) return undefined;
    const bucketMap = response.rateLimitsByLimitId;
    let bucket = isRecord(bucketMap) ? bucketMap[request.limitId] : undefined;
    if (!isRecord(bucket)) {
      const legacyBucket = response.rateLimits;
      bucket =
        isRecord(legacyBucket) && legacyBucket.limitId === request.limitId
          ? legacyBucket
          : undefined;
    }
    if (!isRecord(bucket) || bucket.limitId !== request.limitId) return undefined;
    const reachedType = bucket.rateLimitReachedType;
    const ordinaryUsageAllowed = response.ordinaryUsageAllowed;
    const isKnownReachedType =
      typeof reachedType === 'string' && KNOWN_RATE_LIMIT_REACHED_TYPES.has(reachedType);
    const reachedTypeProvided = reachedType !== undefined && reachedType !== null;
    if (reachedTypeProvided && !isKnownReachedType) return undefined;
    if (ordinaryUsageAllowed !== true && ordinaryUsageAllowed !== false && !isKnownReachedType) {
      // Null/omitted permission is unavailable; never infer exhaustion from
      // usage percentages or optional reset timestamps.
      return undefined;
    }
    if (ordinaryUsageAllowed === true && isKnownReachedType) return undefined;
    const snapshot: ProviderCodexRateLimitSnapshot = {
      limitId: request.limitId,
      exhausted: ordinaryUsageAllowed === false || isKnownReachedType,
      fetchedAt: Date.now(),
    };
    if (generationAtStart !== codexRateLimitCacheGeneration) return undefined;
    return snapshot;
  } catch {
    return undefined;
  } finally {
    lines.close();
    try {
      child.stdin.end();
      if (!exited) {
        await waitForExitOrDelay(exitPromise, 250);
      }
      if (!exited) child.kill('SIGTERM');
      if (!exited) {
        await waitForExitOrDelay(exitPromise, 500);
      }
      if (!exited) child.kill('SIGKILL');
    } catch {
      // The App Server is local and disposable; a failed stop never changes route policy.
    }
  }
}

/** Read one configured Codex quota bucket from the exact direct-chat profile. */
export async function readCodexRateLimit(
  request: ProviderCodexRateLimitRequest
): Promise<ProviderCodexRateLimitSnapshot | undefined> {
  const authProfile = request.options?.codexAuthProfile;
  const codexHome = request.options?.env?.CODEX_HOME;
  if (
    authProfile?.kind !== 'user-oauth' ||
    !authProfile.accountId ||
    authProfile.accountId !== request.expectedAccountId ||
    !codexHome ||
    !isAbsolute(codexHome) ||
    !request.limitId.trim() ||
    !request.cacheScope.trim()
  ) {
    return undefined;
  }

  let authJson: string;
  try {
    const authPath = join(codexHome, 'auth.json');
    const fileStat = await lstat(authPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return undefined;
    authJson = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(authJson) as { tokens?: JsonRecord };
    if (parsed.tokens?.account_id !== request.expectedAccountId) return undefined;
  } catch {
    return undefined;
  }
  const tokenFingerprint = codexTokenFingerprint(authJson);
  if (!tokenFingerprint) return undefined;

  const configCodexBinaryPath = parseCodexConfig(
    request.options?.assistantConfig ?? {}
  ).codexBinaryPath;
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify([
        request.cacheScope,
        request.limitId,
        request.expectedAccountId,
        tokenFingerprint,
      ])
    )
    .digest('hex');
  const now = Date.now();
  for (const [key, entry] of codexRateLimitCache) {
    if (entry.expiresAt <= now) codexRateLimitCache.delete(key);
  }
  const cached = codexRateLimitCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.snapshot;
  codexRateLimitCache.delete(cacheKey);

  const existing = codexRateLimitReads.get(cacheKey);
  if (existing) return existing;
  if (codexRateLimitReads.size >= MAX_CODEX_RATE_LIMIT_READS) return undefined;

  const generationAtStart = codexRateLimitCacheGeneration;
  const read = readCodexRateLimitFromAppServer(
    request,
    codexHome,
    configCodexBinaryPath,
    generationAtStart
  );
  codexRateLimitReads.set(cacheKey, read);
  try {
    const snapshot = await read;
    if (snapshot && generationAtStart === codexRateLimitCacheGeneration) {
      if (codexRateLimitCache.size >= MAX_CODEX_RATE_LIMIT_CACHE) {
        const firstKey = codexRateLimitCache.keys().next().value;
        if (firstKey !== undefined) codexRateLimitCache.delete(firstKey);
      }
      codexRateLimitCache.set(cacheKey, {
        snapshot,
        expiresAt: Date.now() + CODEX_RATE_LIMIT_TTL_MS,
      });
    }
    return snapshot;
  } finally {
    if (codexRateLimitReads.get(cacheKey) === read) codexRateLimitReads.delete(cacheKey);
  }
}
