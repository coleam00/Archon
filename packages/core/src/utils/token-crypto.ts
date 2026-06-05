import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

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
 * Parse TOKEN_ENCRYPTION_KEY (from `env`, default `process.env`) into a 32-byte
 * Buffer. Throws with a clear message if absent or malformed — callers must
 * validate at startup rather than discovering the failure at runtime. The `env`
 * param lets boot-time validators pass the same env they gate on.
 */
export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is required when the GitHub App is configured for per-user tokens. ' +
        'Generate with: openssl rand -hex 32'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32'
    );
  }
  return Buffer.from(hex, 'hex');
}
