import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCredentialKeyPath, createLogger } from '@archon/paths';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('token-crypto');
  return cachedLog;
}

/**
 * In-memory cache keyed by key-file path. Disk I/O happens once per process;
 * keying by path lets tests drive distinct ARCHON_HOME overrides without leaking
 * a cached key across temp dirs.
 */
const localKeyCache = new Map<string, Buffer>();

/** Clear the in-memory key cache and cached logger — exported for test cleanup only. */
export function clearLocalKeyCache(): void {
  localKeyCache.clear();
  cachedLog = undefined;
}

/**
 * Assert the key is the 32 bytes AES-256 requires. Surfaces an Archon-owned,
 * actionable error instead of Node's opaque internal "Invalid key length" if a
 * caller bypasses getEncryptionKey() and passes a wrong-sized buffer.
 */
function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes (AES-256), got ${key.length}`);
  }
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns base64(iv + authTag + ciphertext).
 */
export function encryptToken(plaintext: string, key: Buffer): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt a value produced by encryptToken.
 * Throws if the key is wrong or ciphertext is tampered.
 */
export function decryptToken(ciphertext: string, key: Buffer): string {
  assertKeyLength(key);
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Read or create the local key file at `keyPath` (mode 0600). Returns the
 * 32-byte key. Throws if the file exists but holds malformed content — it never
 * silently regenerates, which would orphan every stored credential. Exported so
 * unit tests can drive it with a temp path.
 */
export function readOrCreateLocalKey(keyPath: string): Buffer {
  const cached = localKeyCache.get(keyPath);
  if (cached) return cached;

  try {
    const content = readFileSync(keyPath, 'utf8').trim();
    if (!HEX_KEY_RE.test(content)) {
      throw new Error(
        `Credential key file at ${keyPath} contains malformed content (expected 64-char hex). ` +
          'Delete the file to generate a new key — stored credentials will need to be re-connected.'
      );
    }
    const key = Buffer.from(content, 'hex');
    assertKeyLength(key);
    localKeyCache.set(keyPath, key);
    return key;
  } catch (err) {
    // Only ENOENT falls through — malformed-content errors have no .code and rethrow here too.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const newKey = randomBytes(KEY_BYTES);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, newKey.toString('hex') + '\n', { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600); // writeFileSync's mode is diluted by umask; enforce explicitly
  } catch {
    /* non-fatal on Windows / filesystems without POSIX perms */
  }
  getLog().info({ path: keyPath }, 'credential_key.generated');
  localKeyCache.set(keyPath, newKey);
  return newKey;
}

/**
 * Resolve the AES-256 encryption key via a three-tier fallback:
 *   1. TOKEN_ENCRYPTION_KEY env var (managed VPS / multi-user — never touches disk)
 *   2. ~/.archon/credential-key file (reads an existing local key)
 *   3. Auto-generate and persist to ~/.archon/credential-key (0600) on first use
 *
 * This makes the per-user credential vault available by default on every install
 * while keeping the explicit env var authoritative where operators set one.
 * Throws when TOKEN_ENCRYPTION_KEY is set but malformed, or when the local key
 * file exists but contains malformed content.
 */
export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.TOKEN_ENCRYPTION_KEY;
  if (hex) {
    if (!HEX_KEY_RE.test(hex)) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
          'Generate with: openssl rand -hex 32'
      );
    }
    return Buffer.from(hex, 'hex');
  }
  return readOrCreateLocalKey(getCredentialKeyPath());
}
