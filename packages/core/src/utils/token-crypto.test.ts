import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { encryptToken, decryptToken, getEncryptionKey } from './token-crypto';

const KEY = Buffer.alloc(32, 7); // deterministic 32-byte key
const OTHER_KEY = Buffer.alloc(32, 9);

describe('token-crypto', () => {
  describe('encryptToken/decryptToken', () => {
    test('round-trips a plaintext token', () => {
      const plain = 'ghu_exampleUserToken1234567890';
      const ciphertext = encryptToken(plain, KEY);
      expect(ciphertext).not.toBe(plain);
      expect(decryptToken(ciphertext, KEY)).toBe(plain);
    });

    test('produces a different ciphertext each call (random IV)', () => {
      const plain = 'ghu_same';
      expect(encryptToken(plain, KEY)).not.toBe(encryptToken(plain, KEY));
    });

    test('round-trips unicode and empty strings', () => {
      for (const plain of ['', 'σ-token-üñ', 'a'.repeat(2048)]) {
        expect(decryptToken(encryptToken(plain, KEY), KEY)).toBe(plain);
      }
    });

    test('throws when decrypting with the wrong key', () => {
      const ciphertext = encryptToken('secret', KEY);
      expect(() => decryptToken(ciphertext, OTHER_KEY)).toThrow();
    });

    test('throws when the ciphertext is tampered', () => {
      const ciphertext = encryptToken('secret', KEY);
      const buf = Buffer.from(ciphertext, 'base64');
      buf[buf.length - 1] ^= 0xff; // flip a bit in the ciphertext body
      expect(() => decryptToken(buf.toString('base64'), KEY)).toThrow();
    });
  });

  describe('getEncryptionKey', () => {
    let original: string | undefined;
    beforeEach(() => {
      original = process.env.TOKEN_ENCRYPTION_KEY;
    });
    afterEach(() => {
      if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = original;
    });

    test('throws when TOKEN_ENCRYPTION_KEY is absent', () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      expect(() => getEncryptionKey()).toThrow(/TOKEN_ENCRYPTION_KEY is required/);
    });

    test('throws when the key is not 64 hex chars', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'tooshort';
      expect(() => getEncryptionKey()).toThrow(/64-character hex/);
    });

    test('throws when the key has non-hex characters', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'z'.repeat(64);
      expect(() => getEncryptionKey()).toThrow(/64-character hex/);
    });

    test('returns a 32-byte Buffer for a valid hex key', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
      const key = getEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test('the parsed key actually decrypts what it encrypts', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
      const key = getEncryptionKey();
      expect(decryptToken(encryptToken('ghr_refresh', key), key)).toBe('ghr_refresh');
    });
  });
});
