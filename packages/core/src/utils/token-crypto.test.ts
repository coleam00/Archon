import { describe, test, expect, afterEach } from 'bun:test';
import { encryptToken, decryptToken, getEncryptionKey } from './token-crypto';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex'); // 32-byte key (all zeros — test only)

describe('encryptToken / decryptToken', () => {
  test('round-trips a plaintext value', () => {
    const plaintext = 'ghp_test_github_token_value';
    const ciphertext = encryptToken(plaintext, TEST_KEY);
    expect(ciphertext).not.toBe(plaintext);
    expect(decryptToken(ciphertext, TEST_KEY)).toBe(plaintext);
  });

  test('produces different ciphertexts for same input (random IV)', () => {
    const plaintext = 'same-value';
    const a = encryptToken(plaintext, TEST_KEY);
    const b = encryptToken(plaintext, TEST_KEY);
    expect(a).not.toBe(b);
    expect(decryptToken(a, TEST_KEY)).toBe(plaintext);
    expect(decryptToken(b, TEST_KEY)).toBe(plaintext);
  });

  test('throws on tampered ciphertext', () => {
    const ciphertext = encryptToken('secret', TEST_KEY);
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip a byte in the ciphertext body
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptToken(buf.toString('base64'), TEST_KEY)).toThrow();
  });

  test('round-trips empty string', () => {
    expect(decryptToken(encryptToken('', TEST_KEY), TEST_KEY)).toBe('');
  });
});

describe('getEncryptionKey', () => {
  const origEnv = process.env.TOKEN_ENCRYPTION_KEY;

  // afterEach restore guarantees cleanup even if a test throws partway through —
  // avoids leaking TOKEN_ENCRYPTION_KEY state into later tests.
  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = origEnv;
    }
  });

  test('parses valid 64-char hex key', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    const key = getEncryptionKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  test('throws when key is absent', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => getEncryptionKey()).toThrow('TOKEN_ENCRYPTION_KEY is required');
  });

  test('throws when key is wrong length', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'abc123';
    expect(() => getEncryptionKey()).toThrow('64-character hex string');
  });
});
