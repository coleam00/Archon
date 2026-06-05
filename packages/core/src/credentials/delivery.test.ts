import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { deliverCredential, KNOWN_PROVIDERS, type ResolvedCredential } from './delivery';

const ART_DIR = '/tmp/archon-test-artifacts';

function apiKey(key = 'sk-test-123'): ResolvedCredential {
  return { kind: 'api_key', apiKey: key };
}

function oauth(token = 'oauth-bearer'): ResolvedCredential {
  return { kind: 'oauth', oauthApiKey: token, rawCreds: { access: token } };
}

describe('credentials/delivery', () => {
  describe('KNOWN_PROVIDERS', () => {
    test('includes the Archon-level provider ids', () => {
      for (const id of ['claude', 'codex', 'anthropic', 'openai']) {
        expect(KNOWN_PROVIDERS.has(id)).toBe(true);
      }
    });

    test('includes the Pi backend provider ids', () => {
      for (const id of ['openrouter', 'google', 'groq', 'xai']) {
        expect(KNOWN_PROVIDERS.has(id)).toBe(true);
      }
    });
  });

  describe('claude', () => {
    test('api_key → CLAUDE_API_KEY + ANTHROPIC_API_KEY (same value)', () => {
      const r = deliverCredential('claude', apiKey('sk-ant-xyz'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ CLAUDE_API_KEY: 'sk-ant-xyz', ANTHROPIC_API_KEY: 'sk-ant-xyz' });
      expect(r.files).toBeUndefined();
    });

    test('oauth → CLAUDE_CODE_OAUTH_TOKEN', () => {
      const r = deliverCredential('claude', oauth('claude-oauth-tok'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-tok' });
      expect(r.files).toBeUndefined();
    });
  });

  describe('codex', () => {
    test('api_key → OPENAI_API_KEY', () => {
      const r = deliverCredential('codex', apiKey('sk-codex'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ OPENAI_API_KEY: 'sk-codex' });
      expect(r.files).toBeUndefined();
    });

    test('oauth → CODEX_HOME env + auth.json file under artifactsDir', () => {
      const r = deliverCredential('codex', oauth(), { artifactsDir: ART_DIR });
      expect(r.env.CODEX_HOME).toBe(join(ART_DIR, 'codex-home'));
      expect(r.files).toBeDefined();
      expect(r.files).toHaveLength(1);
      const file = r.files![0]!;
      expect(file.path).toBe(join(ART_DIR, 'codex-home', 'auth.json'));
      // Contents is JSON of the raw creds blob (shape verification deferred to G5)
      const parsed = JSON.parse(file.contents) as Record<string, unknown>;
      expect(parsed.access).toBe('oauth-bearer');
    });
  });

  describe('anthropic / openai (api-key-only)', () => {
    test('anthropic api_key → ANTHROPIC_API_KEY', () => {
      const r = deliverCredential('anthropic', apiKey('sk-ant-direct'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-direct' });
    });

    test('openai api_key → OPENAI_API_KEY', () => {
      const r = deliverCredential('openai', apiKey('sk-openai-direct'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ OPENAI_API_KEY: 'sk-openai-direct' });
    });

    test('anthropic oauth → throws (use claude instead)', () => {
      expect(() => deliverCredential('anthropic', oauth(), { artifactsDir: ART_DIR })).toThrow(
        /use provider 'claude'/
      );
    });

    test('openai oauth → throws (use codex instead)', () => {
      expect(() => deliverCredential('openai', oauth(), { artifactsDir: ART_DIR })).toThrow(
        /use provider 'codex'/
      );
    });
  });

  describe('Pi backends', () => {
    test('openrouter api_key → OPENROUTER_API_KEY', () => {
      const r = deliverCredential('openrouter', apiKey('or-key'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ OPENROUTER_API_KEY: 'or-key' });
    });

    test('google api_key → GEMINI_API_KEY', () => {
      const r = deliverCredential('google', apiKey('g-key'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ GEMINI_API_KEY: 'g-key' });
    });

    test('xai api_key → XAI_API_KEY', () => {
      const r = deliverCredential('xai', apiKey('x-key'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ XAI_API_KEY: 'x-key' });
    });

    test('Pi backend oauth → throws (API-key only)', () => {
      expect(() => deliverCredential('openrouter', oauth(), { artifactsDir: ART_DIR })).toThrow(
        /API-key only/
      );
    });
  });

  describe('unknown provider', () => {
    test('throws with the list of known providers', () => {
      expect(() => deliverCredential('mystery', apiKey(), { artifactsDir: ART_DIR })).toThrow(
        /Unknown credential provider 'mystery'/
      );
    });
  });
});
