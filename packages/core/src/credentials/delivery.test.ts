import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import {
  deliverCredential,
  buildPiAuthJson,
  KNOWN_VENDORS,
  LEGACY_VENDOR_ALIASES,
  normalizeCredentialVendor,
  type ResolvedCredential,
} from './delivery';

const ART_DIR = '/tmp/archon-test-artifacts';

function apiKey(key = 'sk-test-123'): ResolvedCredential {
  return { kind: 'api_key', apiKey: key };
}

function oauth(token = 'oauth-bearer'): ResolvedCredential {
  return { kind: 'oauth', oauthApiKey: token, rawCreds: { access: token } };
}

describe('credentials/delivery', () => {
  describe('KNOWN_VENDORS', () => {
    test('includes the vendor-canonical agent credential ids', () => {
      for (const id of ['anthropic', 'openai', 'github-copilot']) {
        expect(KNOWN_VENDORS.has(id)).toBe(true);
      }
    });

    test('includes the Pi backend vendor ids (full generated coverage)', () => {
      for (const id of ['openrouter', 'google', 'groq', 'xai', 'deepseek', 'together', 'zai']) {
        expect(KNOWN_VENDORS.has(id)).toBe(true);
      }
    });

    test('excludes legacy agent-keyed ids and ambient vendors', () => {
      for (const id of ['claude', 'codex', 'copilot', 'amazon-bedrock']) {
        expect(KNOWN_VENDORS.has(id)).toBe(false);
      }
    });
  });

  describe('normalizeCredentialVendor', () => {
    test('maps legacy agent-keyed ids to vendor ids', () => {
      expect(normalizeCredentialVendor('claude')).toBe('anthropic');
      expect(normalizeCredentialVendor('codex')).toBe('openai');
      expect(normalizeCredentialVendor('copilot')).toBe('github-copilot');
    });

    test('passes vendor ids through unchanged', () => {
      for (const id of ['anthropic', 'openai', 'github-copilot', 'openrouter', 'mystery']) {
        expect(normalizeCredentialVendor(id)).toBe(id);
      }
    });

    test('alias table covers exactly the three pre-#1955 ids', () => {
      expect(Object.keys(LEGACY_VENDOR_ALIASES).sort()).toEqual(['claude', 'codex', 'copilot']);
    });
  });

  describe('anthropic', () => {
    test('api_key → ANTHROPIC_API_KEY + CLAUDE_API_KEY (same value)', () => {
      const r = deliverCredential('anthropic', apiKey('sk-ant-xyz'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-xyz', CLAUDE_API_KEY: 'sk-ant-xyz' });
      expect(r.files).toBeUndefined();
    });

    test('oauth (Claude Pro/Max subscription) → CLAUDE_CODE_OAUTH_TOKEN', () => {
      const r = deliverCredential('anthropic', oauth('claude-oauth-tok'), {
        artifactsDir: ART_DIR,
      });
      expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-tok' });
      expect(r.files).toBeUndefined();
    });

    test("legacy 'claude' id normalizes to the same delivery", () => {
      const viaLegacy = deliverCredential('claude', apiKey('k'), { artifactsDir: ART_DIR });
      const viaVendor = deliverCredential('anthropic', apiKey('k'), { artifactsDir: ART_DIR });
      expect(viaLegacy).toEqual(viaVendor);
    });
  });

  describe('openai', () => {
    test('api_key → OPENAI_API_KEY', () => {
      const r = deliverCredential('openai', apiKey('sk-codex'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ OPENAI_API_KEY: 'sk-codex' });
      expect(r.files).toBeUndefined();
    });

    test('oauth (ChatGPT subscription) → CODEX_HOME env + auth.json file under artifactsDir', () => {
      const r = deliverCredential('openai', oauth(), { artifactsDir: ART_DIR });
      expect(r.env.CODEX_HOME).toBe(join(ART_DIR, 'codex-home'));
      expect(r.files).toBeDefined();
      expect(r.files).toHaveLength(1);
      const file = r.files![0]!;
      expect(file.path).toBe(join(ART_DIR, 'codex-home', 'auth.json'));
      // Contents maps onto the Codex CLI auth.json shape (server/.../setup-auth.ts):
      // { OPENAI_API_KEY: null, tokens: { access_token, ... }, last_refresh }.
      const parsed = JSON.parse(file.contents) as {
        OPENAI_API_KEY: null;
        tokens: { access_token: string };
        last_refresh: string;
      };
      expect(parsed.OPENAI_API_KEY).toBeNull();
      expect(parsed.tokens.access_token).toBe('oauth-bearer');
      expect(typeof parsed.last_refresh).toBe('string');
    });

    test('oauth → full tokens shape; real id_token from the Archon-owned flow (#1924)', () => {
      const cred: ResolvedCredential = {
        kind: 'oauth',
        oauthApiKey: 'x',
        rawCreds: {
          access: 'acc-tok',
          refresh: 'ref-tok',
          expires: 123,
          accountId: 'acct-9',
          id_token: 'idt-real',
        },
      };
      const r = deliverCredential('codex', cred, { artifactsDir: ART_DIR });
      const parsed = JSON.parse(r.files![0]!.contents) as {
        OPENAI_API_KEY: null;
        tokens: Record<string, string>;
        last_refresh: string;
      };
      expect(parsed.OPENAI_API_KEY).toBeNull();
      expect(parsed.tokens).toEqual({
        id_token: 'idt-real', // captured by openai-oauth.ts (Pi drops it)
        access_token: 'acc-tok',
        refresh_token: 'ref-tok',
        account_id: 'acct-9', // mapped from the camelCase `accountId`
      });
    });

    test('legacy Pi-minted blob without id_token → empty string (run fails with the known Codex error; reconnect mints a full blob)', () => {
      const cred: ResolvedCredential = {
        kind: 'oauth',
        oauthApiKey: 'x',
        rawCreds: { access: 'acc-tok', refresh: 'ref-tok', expires: 123, accountId: 'acct-9' },
      };
      const r = deliverCredential('codex', cred, { artifactsDir: ART_DIR });
      const parsed = JSON.parse(r.files![0]!.contents) as { tokens: Record<string, string> };
      expect(parsed.tokens.id_token).toBe('');
    });
  });

  describe('github-copilot', () => {
    test('api_key → COPILOT_GITHUB_TOKEN', () => {
      const r = deliverCredential('github-copilot', apiKey('pat-x'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ COPILOT_GITHUB_TOKEN: 'pat-x' });
    });

    test('oauth → COPILOT_GITHUB_TOKEN', () => {
      const r = deliverCredential('github-copilot', oauth('cop-tok'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ COPILOT_GITHUB_TOKEN: 'cop-tok' });
    });

    test("legacy 'copilot' id normalizes to the same delivery", () => {
      const r = deliverCredential('copilot', apiKey('pat-y'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ COPILOT_GITHUB_TOKEN: 'pat-y' });
    });
  });

  describe('buildPiAuthJson', () => {
    test('null when no credential maps to a Pi backend', () => {
      expect(buildPiAuthJson([])).toBeNull();
      expect(buildPiAuthJson([{ provider: 'totally-unknown', cred: apiKey('x') }])).toBeNull();
    });

    test('aggregates api keys + subscriptions keyed by Pi backend id', () => {
      const json = buildPiAuthJson([
        { provider: 'openrouter', cred: apiKey('sk-or') },
        { provider: 'anthropic', cred: oauth('cl-tok') },
      ]);
      expect(json).not.toBeNull();
      const data = JSON.parse(json!) as Record<
        string,
        { type: string; key?: string; access?: string }
      >;
      expect(data.openrouter).toEqual({ type: 'api_key', key: 'sk-or' });
      expect(data.anthropic?.type).toBe('oauth');
      expect(data.anthropic?.access).toBe('cl-tok');
    });

    test('legacy agent-keyed rows normalize onto Pi backend ids', () => {
      const json = buildPiAuthJson([
        { provider: 'claude', cred: oauth('cl-tok') },
        { provider: 'codex', cred: apiKey('sk-oa') },
      ]);
      const data = JSON.parse(json!) as Record<string, { type: string }>;
      expect(data.anthropic?.type).toBe('oauth');
      expect(data.openai?.type).toBe('api_key');
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

    test('huggingface api_key → HF_TOKEN (pi-ai upstream var, not HUGGINGFACE_API_KEY)', () => {
      // Regression: the hand-maintained map drifted to HUGGINGFACE_API_KEY,
      // which pi-ai never reads. The generated map fixed it (#1955).
      const r = deliverCredential('huggingface', apiKey('hf-key'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ HF_TOKEN: 'hf-key' });
    });

    test('newly covered backends deliver their env var (deepseek)', () => {
      const r = deliverCredential('deepseek', apiKey('ds-key'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ DEEPSEEK_API_KEY: 'ds-key' });
    });

    test('google-vertex api_key delivers (dual-kind vendor takes the env path, not the ambient throw)', () => {
      const r = deliverCredential('google-vertex', apiKey('gv-key'), { artifactsDir: ART_DIR });
      expect(r.env).toEqual({ GOOGLE_CLOUD_API_KEY: 'gv-key' });
    });

    test('Pi backend oauth → throws (subscriptions reach Pi via auth.json, not env)', () => {
      expect(() => deliverCredential('openrouter', oauth(), { artifactsDir: ART_DIR })).toThrow(
        /auth\.json/
      );
    });
  });

  describe('ambient vendors', () => {
    test('amazon-bedrock → throws (ambient chains are never stored)', () => {
      expect(() =>
        deliverCredential('amazon-bedrock', apiKey(), { artifactsDir: ART_DIR })
      ).toThrow(/ambient/);
    });
  });

  describe('unknown vendor', () => {
    test('throws with the list of known vendors', () => {
      expect(() => deliverCredential('mystery', apiKey(), { artifactsDir: ART_DIR })).toThrow(
        /Unknown credential vendor 'mystery'/
      );
    });
  });
});
