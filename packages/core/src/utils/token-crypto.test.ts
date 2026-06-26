import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs';
import {
  encryptToken,
  decryptToken,
  getEncryptionKey,
  readOrCreateLocalKey,
  clearLocalKeyCache,
} from './token-crypto';

const KEY = Buffer.alloc(32, 7); // deterministic 32-byte key
const OTHER_KEY = Buffer.alloc(32, 9);

let tmpCounter = 0;
function makeTmpDir(): string {
  const dir = join(tmpdir(), `archon-token-crypto-${process.pid}-${tmpCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
    let origKey: string | undefined;
    let origHome: string | undefined;
    let tmpDir: string;

    beforeEach(() => {
      origKey = process.env.TOKEN_ENCRYPTION_KEY;
      origHome = process.env.ARCHON_HOME;
      tmpDir = makeTmpDir();
      // Point ARCHON_HOME at a temp dir so the auto-key never touches the real
      // ~/.archon/credential-key on a dev machine.
      process.env.ARCHON_HOME = tmpDir;
      clearLocalKeyCache();
    });

    afterEach(() => {
      if (origKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = origKey;
      if (origHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = origHome;
      clearLocalKeyCache();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test('env var path: returns a 32-byte Buffer for a valid 64-hex key', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
      const key = getEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test('env var path: throws when the key is not 64 hex chars', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'tooshort';
      expect(() => getEncryptionKey()).toThrow(/64-character hex/);
    });

    test('env var path: throws when the key has non-hex characters', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'z'.repeat(64);
      expect(() => getEncryptionKey()).toThrow(/64-character hex/);
    });

    test('auto-key path: generates a key file when TOKEN_ENCRYPTION_KEY is absent', () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      const key = getEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
      const content = readFileSync(join(tmpDir, 'credential-key'), 'utf8').trim();
      expect(content).toMatch(/^[0-9a-fA-F]{64}$/);
    });

    test('env var wins over the key file when both exist', () => {
      const envKey = 'b'.repeat(64);
      process.env.TOKEN_ENCRYPTION_KEY = envKey;
      writeFileSync(join(tmpDir, 'credential-key'), 'c'.repeat(64) + '\n', { mode: 0o600 });
      expect(getEncryptionKey()).toEqual(Buffer.from(envKey, 'hex'));
    });

    test('auto-key path: the same key is returned across calls (persisted)', () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      const key1 = getEncryptionKey();
      clearLocalKeyCache(); // force a re-read from disk
      const key2 = getEncryptionKey();
      expect(key1).toEqual(key2);
    });

    test('auto-key path: decrypts what it encrypts using the generated key', () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      const key = getEncryptionKey();
      expect(decryptToken(encryptToken('my-api-key', key), key)).toBe('my-api-key');
    });
  });

  describe('readOrCreateLocalKey', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTmpDir();
      clearLocalKeyCache();
    });

    afterEach(() => {
      clearLocalKeyCache();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test('generates a new key file (0600) when the path does not exist', () => {
      const keyPath = join(tmpDir, 'credential-key');
      const key = readOrCreateLocalKey(keyPath);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    });

    test('reads an existing valid key file without regenerating', () => {
      const keyPath = join(tmpDir, 'credential-key');
      writeFileSync(keyPath, 'd'.repeat(64) + '\n', { mode: 0o600 });
      expect(readOrCreateLocalKey(keyPath)).toEqual(Buffer.from('d'.repeat(64), 'hex'));
    });

    test('throws (does NOT regenerate) when the key file has malformed content', () => {
      const keyPath = join(tmpDir, 'credential-key');
      writeFileSync(keyPath, 'not-a-hex-key\n', { mode: 0o600 });
      expect(() => readOrCreateLocalKey(keyPath)).toThrow(/malformed content/);
      // The malformed file must be left intact, never silently overwritten.
      expect(readFileSync(keyPath, 'utf8').trim()).toBe('not-a-hex-key');
    });

    test('caches the key in memory — a second call skips the disk read', () => {
      const keyPath = join(tmpDir, 'credential-key');
      const key1 = readOrCreateLocalKey(keyPath);
      rmSync(keyPath); // delete the file; cached call must not hit ENOENT
      expect(readOrCreateLocalKey(keyPath)).toEqual(key1);
    });
  });
});
