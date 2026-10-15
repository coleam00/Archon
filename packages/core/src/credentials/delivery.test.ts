// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { CODEX_CREDENTIAL_ENV } from '@archon/providers';
import {
  deliverCredential,
  buildPiAuthJson,
  KNOWN_VENDORS,
  normalizeCredentialVendor,
  type ResolvedCredential,
} from './delivery';

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

    test('maps the renamed Pi Azure credential vendor', () => {
      expect(normalizeCredentialVendor('azure-openai-responses')).toBe('azure');
    });
  });

  test.each(['azure', 'azure-openai-responses'])('delivers an Azure key stored as %s', vendor => {
    expect(deliverCredential(vendor, apiKey('azure-key'))).toEqual({
      env: { AZURE_OPENAI_API_KEY: 'azure-key' },
    });
    expect(JSON.parse(buildPiAuthJson([{ provider: vendor, cred: apiKey('azure-key') }])!)).toEqual(
      {
        azure: { type: 'api_key', key: 'azure-key' },
      }
    );
  });

  describe('anthropic', () => {
    test('api_key → ANTHROPIC_API_KEY + CLAUDE_API_KEY (same value)', () => {
      const r = deliverCredential('anthropic', apiKey('sk-ant-xyz'));
      expect(r).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ant-xyz', CLAUDE_API_KEY: 'sk-ant-xyz' } });
    });

    test('oauth (Claude Pro/Max subscription) → CLAUDE_CODE_OAUTH_TOKEN only, nothing Pi reads', () => {
      const r = deliverCredential('anthropic', oauth('claude-oauth-tok'));
      expect(r).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-tok' } });
    });

    test("legacy 'claude' id normalizes to the same delivery", () => {
      const viaLegacy = deliverCredential('claude', apiKey('k'));
      const viaVendor = deliverCredential('anthropic', apiKey('k'));
      expect(viaLegacy).toEqual(viaVendor);
    });
  });

  describe('openai', () => {
    const TOKEN_ENV = CODEX_CREDENTIAL_ENV.chatgptAccessToken;
    const ACCOUNT_ENV = CODEX_CREDENTIAL_ENV.chatgptAccountId;

    function subscription(rawCreds: Record<string, unknown>): ResolvedCredential {
      return { kind: 'oauth', oauthApiKey: 'minted-bearer', rawCreds };
    }

    test('api_key → OPENAI_API_KEY for Pi and CODEX_API_KEY for Codex', () => {
      const r = deliverCredential('openai', apiKey('sk-codex'));
      expect(r).toEqual({ env: { OPENAI_API_KEY: 'sk-codex', CODEX_API_KEY: 'sk-codex' } });
    });

    test('oauth (ChatGPT subscription) → in-memory Codex login env, no CODEX_HOME and no files', () => {
      const cred = subscription({
        access: 'raw-access',
        refresh: 'ref-tok',
        expires: 123,
        accountId: 'acct-9',
        id_token: 'idt-real',
      });
      // The minted bearer, not the raw access token, is what Codex logs in with.
      expect(deliverCredential('codex', cred)).toEqual({
        env: { [TOKEN_ENV]: 'minted-bearer', [ACCOUNT_ENV]: 'acct-9' },
      });
    });

    test('oauth without an id_token still delivers (legacy Pi-minted blob)', () => {
      const cred = subscription({ access: 'a', refresh: 'r', expires: 1, accountId: 'acct-9' });
      expect(deliverCredential('openai', cred).env).toEqual({
        [TOKEN_ENV]: 'minted-bearer',
        [ACCOUNT_ENV]: 'acct-9',
      });
    });

    test('oauth without an accountId throws a reconnect error', () => {
      expect(() => deliverCredential('openai', subscription({ access: 'a' }))).toThrow(
        /archon ai login openai/
      );
    });
  });

  describe('github-copilot', () => {
    test('api_key → COPILOT_GITHUB_TOKEN', () => {
      const r = deliverCredential('github-copilot', apiKey('pat-x'));
      expect(r.env).toEqual({ COPILOT_GITHUB_TOKEN: 'pat-x' });
    });

    test('oauth → COPILOT_GITHUB_TOKEN', () => {
      const r = deliverCredential('github-copilot', oauth('cop-tok'));
      expect(r.env).toEqual({ COPILOT_GITHUB_TOKEN: 'cop-tok' });
    });

    test("legacy 'copilot' id normalizes to the same delivery", () => {
      const r = deliverCredential('copilot', apiKey('pat-y'));
      expect(r.env).toEqual({ COPILOT_GITHUB_TOKEN: 'pat-y' });
    });
  });

  describe('buildPiAuthJson', () => {
    test('null when no credential maps to a Pi backend', () => {
      expect(buildPiAuthJson([])).toBeNull();
      expect(buildPiAuthJson([{ provider: 'totally-unknown', cred: apiKey('x') }])).toBeNull();
    });

    test('aggregates the api keys + subscriptions Pi consumes, keyed by Pi backend id', () => {
      const json = buildPiAuthJson([
        { provider: 'openrouter', cred: apiKey('sk-or') },
        { provider: 'openai', cred: oauth('oa-tok') },
      ]);
      expect(json).not.toBeNull();
      const data = JSON.parse(json!) as Record<
        string,
        { type: string; key?: string; access?: string }
      >;
      expect(data.openrouter).toEqual({ type: 'api_key', key: 'sk-or' });
      expect(data.openai?.type).toBe('oauth');
      expect(data.openai?.access).toBe('oa-tok');
    });

    test('a Claude subscription is not delivered to Pi; an Anthropic API key is', () => {
      expect(buildPiAuthJson([{ provider: 'anthropic', cred: oauth('cl-tok') }])).toBeNull();
      const json = buildPiAuthJson([{ provider: 'anthropic', cred: apiKey('sk-ant') }]);
      expect(JSON.parse(json!)).toEqual({ anthropic: { type: 'api_key', key: 'sk-ant' } });
    });

    test('legacy agent-keyed rows normalize onto Pi backend ids', () => {
      const json = buildPiAuthJson([
        { provider: 'claude', cred: apiKey('sk-ant') },
        { provider: 'codex', cred: apiKey('sk-oa') },
      ]);
      const data = JSON.parse(json!) as Record<string, { type: string }>;
      expect(data.anthropic?.type).toBe('api_key');
      expect(data.openai?.type).toBe('api_key');
    });
  });

  describe('Pi backends', () => {
    test('openrouter api_key → OPENROUTER_API_KEY', () => {
      const r = deliverCredential('openrouter', apiKey('or-key'));
      expect(r.env).toEqual({ OPENROUTER_API_KEY: 'or-key' });
    });

    test('google api_key → GEMINI_API_KEY', () => {
      const r = deliverCredential('google', apiKey('g-key'));
      expect(r.env).toEqual({ GEMINI_API_KEY: 'g-key' });
    });

    test('huggingface api_key → HF_TOKEN (pi-ai upstream var, not HUGGINGFACE_API_KEY)', () => {
      // Regression: the hand-maintained map drifted to HUGGINGFACE_API_KEY,
      // which pi-ai never reads. The generated map fixed it (#1955).
      const r = deliverCredential('huggingface', apiKey('hf-key'));
      expect(r.env).toEqual({ HF_TOKEN: 'hf-key' });
    });

    test('newly covered backends deliver their env var (deepseek)', () => {
      const r = deliverCredential('deepseek', apiKey('ds-key'));
      expect(r.env).toEqual({ DEEPSEEK_API_KEY: 'ds-key' });
    });

    test('google-vertex api_key delivers (dual-kind vendor takes the env path, not the ambient throw)', () => {
      const r = deliverCredential('google-vertex', apiKey('gv-key'));
      expect(r.env).toEqual({ GOOGLE_CLOUD_API_KEY: 'gv-key' });
    });

    test('Pi backend oauth → throws (subscriptions reach Pi via auth.json, not env)', () => {
      expect(() => deliverCredential('openrouter', oauth())).toThrow(/auth\.json/);
    });
  });

  describe('ambient vendors', () => {
    test('amazon-bedrock → throws (ambient chains are never stored)', () => {
      expect(() => deliverCredential('amazon-bedrock', apiKey())).toThrow(/ambient/);
    });
  });

  describe('unknown vendor', () => {
    test('throws with the list of known vendors', () => {
      expect(() => deliverCredential('mystery', apiKey())).toThrow(
        /Unknown credential vendor 'mystery'/
      );
    });
  });
});
