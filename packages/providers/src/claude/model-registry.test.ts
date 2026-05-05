import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempHome: string;
const TEST_ENV_VARS = [
  'ARCHON_TEST_CLAUDE_API_KEY',
  'ARCHON_TEST_CLAUDE_AUTH_TOKEN',
  'ARCHON_TEST_CLAUDE_BASE_URL',
  'ARCHON_TEST_CLAUDE_HEADER',
];

mock.module('@archon/paths', () => ({
  getArchonHome: () => tempHome,
  BUNDLED_IS_BINARY: false,
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

const { ClaudeModelRegistry } = await import('./model-registry');

function writeModelsConfig(config: unknown): void {
  writeFileSync(join(tempHome, 'claude-models.json'), JSON.stringify(config));
}

const SAMPLE_CONFIG = {
  providers: {
    acme: {
      baseUrl: 'https://api.acme-corp.example.com',
      apiKey: 'sk-test-acme-key-123',
      models: [
        { id: 'acme/fast-model-v2', name: 'fast' },
        { id: 'acme/reasoning-xl', name: 'smart' },
        { id: 'acme/code-gen-4', name: 'coder' },
      ],
    },
    local: {
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'local-key',
      models: [{ id: 'llama3.1:8b', name: 'llama' }],
    },
  },
};

describe('ClaudeModelRegistry', () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'archon-claude-models-test-'));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    for (const name of TEST_ENV_VARS) delete process.env[name];
  });

  describe('file loading', () => {
    test('returns passthrough when no claude-models.json exists', () => {
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('claude-sonnet-4-20250514');
      expect(result).toEqual({ resolvedId: 'claude-sonnet-4-20250514', matchedBy: 'passthrough' });
      expect(registry.getError()).toBeUndefined();
    });

    test('reports error for invalid JSON', () => {
      writeFileSync(join(tempHome, 'claude-models.json'), 'not valid json{{{');
      const registry = new ClaudeModelRegistry();
      expect(registry.getError()).toContain('Invalid JSON');
      expect(registry.getAll()).toEqual([]);
      expect(registry.resolve('gpt').matchedBy).toBe('passthrough');
    });

    test('reports error when providers field is missing', () => {
      writeModelsConfig({ wrong: 'shape' });
      const registry = new ClaudeModelRegistry();
      expect(registry.getError()).toContain('must have a "providers" object');
    });

    test('reports error when providers field is null or an array', () => {
      writeModelsConfig({ providers: null });
      const nullRegistry = new ClaudeModelRegistry();
      expect(nullRegistry.getError()).toContain('must have a "providers" object');
      expect(nullRegistry.getAll()).toEqual([]);

      writeModelsConfig({ providers: [] });
      const arrayRegistry = new ClaudeModelRegistry();
      expect(arrayRegistry.getError()).toContain('must have a "providers" object');
      expect(arrayRegistry.getAll()).toEqual([]);
    });

    test('skips providers with missing baseUrl or credentials', () => {
      writeModelsConfig({
        providers: {
          nokey: { baseUrl: 'http://example.com', models: [{ id: 'x', name: 'y' }] },
          nourl: { apiKey: 'key', models: [{ id: 'x', name: 'y' }] },
          token: {
            baseUrl: 'http://token.example.com',
            authToken: 'token',
            models: [{ id: 'model-2', name: 'two' }],
          },
          valid: {
            baseUrl: 'http://example.com',
            apiKey: 'key',
            models: [{ id: 'model-1', name: 'one' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      expect(registry.getAll()).toEqual([
        { providerName: 'token', model: { id: 'model-2', name: 'two' } },
        { providerName: 'valid', model: { id: 'model-1', name: 'one' } },
      ]);
    });

    test('skips providers with empty baseUrl or credentials and reports validation error', () => {
      writeModelsConfig({
        providers: {
          emptyBaseUrl: { baseUrl: '', apiKey: 'key', models: [{ id: 'x', name: 'x' }] },
          emptyApiKey: {
            baseUrl: 'http://empty-key.example.com',
            apiKey: '',
            models: [{ id: 'y', name: 'y' }],
          },
          valid: {
            baseUrl: 'http://example.com',
            apiKey: 'key',
            models: [{ id: 'model-1', name: 'one' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      expect(registry.getAll()).toEqual([
        { providerName: 'valid', model: { id: 'model-1', name: 'one' } },
      ]);
      expect(registry.getError()).toContain('baseUrl must be a non-empty string');
      expect(registry.getError()).toContain('apiKey or authToken must be a non-empty string');
      expect(registry.resolve('x').matchedBy).toBe('passthrough');
      expect(registry.resolve('y').matchedBy).toBe('passthrough');
    });

    test('filters out malformed model entries', () => {
      writeModelsConfig({
        providers: {
          test: {
            baseUrl: 'http://test.com',
            apiKey: 'key',
            models: [
              { id: 'valid-id', name: 'valid' },
              { id: 123, name: 'bad-id' },
              { id: 'no-name' },
              null,
              { id: 'also-valid', name: 'good' },
            ],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all[0].model.id).toBe('valid-id');
      expect(all[1].model.id).toBe('also-valid');
    });

    test('handles non-ENOENT read errors gracefully', () => {
      mkdirSync(join(tempHome, 'claude-models.json'));
      const registry = new ClaudeModelRegistry();
      expect(registry.getError()).toContain('Failed to read');
    });
  });

  describe('model resolution', () => {
    test('resolves by exact model id', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('acme/fast-model-v2');
      expect(result.resolvedId).toBe('acme/fast-model-v2');
      expect(result.matchedBy).toBe('id');
      expect(result.providerName).toBe('acme');
    });

    test('resolves by name (case-insensitive)', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      const result = registry.resolve('fast');
      expect(result.resolvedId).toBe('acme/fast-model-v2');
      expect(result.matchedBy).toBe('name');
      expect(result.providerName).toBe('acme');

      const upper = registry.resolve('FAST');
      expect(upper.resolvedId).toBe('acme/fast-model-v2');
      expect(upper.matchedBy).toBe('name');
    });

    test('resolves by case-insensitive id', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('ACME/Fast-Model-V2');
      expect(result.resolvedId).toBe('acme/fast-model-v2');
      expect(result.matchedBy).toBe('id');
    });

    test('passthrough when no match found', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('claude-sonnet-4-20250514');
      expect(result).toEqual({ resolvedId: 'claude-sonnet-4-20250514', matchedBy: 'passthrough' });
    });

    test('resolves models from different providers', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      const fast = registry.resolve('fast');
      expect(fast.providerName).toBe('acme');
      expect(fast.env?.ANTHROPIC_BASE_URL).toBe('https://api.acme-corp.example.com');

      const llama = registry.resolve('llama');
      expect(llama.providerName).toBe('local');
      expect(llama.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:11434/v1');
    });

    test('resolves "provider/name" format to the correct model within that provider', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      const result = registry.resolve('acme/fast');
      expect(result.resolvedId).toBe('acme/fast-model-v2');
      expect(result.matchedBy).toBe('name');
      expect(result.providerName).toBe('acme');
      expect(result.env?.ANTHROPIC_BASE_URL).toBe('https://api.acme-corp.example.com');
    });

    test('resolves "provider/name" case-insensitively', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      const result = registry.resolve('acme/SMART');
      expect(result.resolvedId).toBe('acme/reasoning-xl');
      expect(result.matchedBy).toBe('name');
      expect(result.providerName).toBe('acme');
    });

    test('"provider/id" format also works for model id lookup within provider', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      const result = registry.resolve('local/llama3.1:8b');
      expect(result.resolvedId).toBe('llama3.1:8b');
      expect(result.matchedBy).toBe('id');
      expect(result.providerName).toBe('local');
    });

    test('"provider/name" falls through to global search if provider not found', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      // "unknown" is not a registered provider, so "unknown/fast" won't match
      // provider-scoped, but "fast" won't match globally either since full string is searched
      const result = registry.resolve('unknown/fast');
      expect(result.matchedBy).toBe('passthrough');
    });

    test('each node in a workflow gets its own provider env (multi-provider scenario)', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      // Node 1: uses acme provider model
      const node1 = registry.resolve('fast');
      expect(node1.resolvedId).toBe('acme/fast-model-v2');
      expect(node1.env?.ANTHROPIC_BASE_URL).toBe('https://api.acme-corp.example.com');
      expect(node1.env?.ANTHROPIC_API_KEY).toBe('sk-test-acme-key-123');

      // Node 2: uses local provider model
      const node2 = registry.resolve('llama');
      expect(node2.resolvedId).toBe('llama3.1:8b');
      expect(node2.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:11434/v1');
      expect(node2.env?.ANTHROPIC_API_KEY).toBe('local-key');

      // Node 3: uses standard Claude model (no custom provider)
      const node3 = registry.resolve('claude-sonnet-4-20250514');
      expect(node3.resolvedId).toBe('claude-sonnet-4-20250514');
      expect(node3.matchedBy).toBe('passthrough');
      expect(node3.env).toBeUndefined();
    });
  });

  describe('env injection', () => {
    test('injects ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY for matched models', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('fast');
      expect(result.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.acme-corp.example.com',
        ANTHROPIC_API_KEY: 'sk-test-acme-key-123',
      });
    });

    test('injects ANTHROPIC_AUTH_TOKEN when provider uses bearer token auth', () => {
      writeModelsConfig({
        providers: {
          gateway: {
            baseUrl: 'https://gateway.example.com',
            authToken: 'gateway-token',
            models: [{ id: 'gateway/model', name: 'gateway' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('gateway');
      expect(result.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
      });
    });

    test('resolves apiKey from an environment variable name with literal fallback', () => {
      process.env.ARCHON_TEST_CLAUDE_API_KEY = 'resolved-api-key';
      writeModelsConfig({
        providers: {
          envProvider: {
            baseUrl: 'https://gateway.example.com',
            apiKey: 'ARCHON_TEST_CLAUDE_API_KEY',
            models: [{ id: 'gateway/model', name: 'gateway' }],
          },
          literalProvider: {
            baseUrl: 'https://literal.example.com',
            apiKey: 'literal-api-key',
            models: [{ id: 'literal/model', name: 'literal' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();

      expect(registry.resolve('gateway').env?.ANTHROPIC_API_KEY).toBe('resolved-api-key');
      expect(registry.resolve('literal').env?.ANTHROPIC_API_KEY).toBe('literal-api-key');
    });

    test('resolves authToken, baseUrl, and headers from environment variable names', () => {
      process.env.ARCHON_TEST_CLAUDE_AUTH_TOKEN = 'resolved-auth-token';
      process.env.ARCHON_TEST_CLAUDE_BASE_URL = 'https://resolved.example.com';
      process.env.ARCHON_TEST_CLAUDE_HEADER = 'resolved-header-value';
      writeModelsConfig({
        providers: {
          gateway: {
            baseUrl: 'ARCHON_TEST_CLAUDE_BASE_URL',
            authToken: 'ARCHON_TEST_CLAUDE_AUTH_TOKEN',
            headers: { 'X-Test': 'ARCHON_TEST_CLAUDE_HEADER' },
            models: [{ id: 'gateway/model', name: 'gateway' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('gateway');

      expect(result.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://resolved.example.com',
        ANTHROPIC_AUTH_TOKEN: 'resolved-auth-token',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Test: resolved-header-value',
      });
      expect(result.headers).toEqual({ 'X-Test': 'resolved-header-value' });
    });

    test('supports $-prefixed environment variable names', () => {
      process.env.ARCHON_TEST_CLAUDE_API_KEY = 'resolved-dollar-api-key';
      writeModelsConfig({
        providers: {
          gateway: {
            baseUrl: 'https://gateway.example.com',
            apiKey: '$ARCHON_TEST_CLAUDE_API_KEY',
            models: [{ id: 'gateway/model', name: 'gateway' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();

      expect(registry.resolve('gateway').env?.ANTHROPIC_API_KEY).toBe('resolved-dollar-api-key');
    });

    test('does not inject env for passthrough models', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('claude-sonnet-4-20250514');
      expect(result.env).toBeUndefined();
    });

    test('different providers inject their own credentials', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();

      const acme = registry.resolve('smart');
      expect(acme.env?.ANTHROPIC_API_KEY).toBe('sk-test-acme-key-123');

      const local = registry.resolve('llama');
      expect(local.env?.ANTHROPIC_API_KEY).toBe('local-key');
    });
  });

  describe('headers', () => {
    test('returns headers when provider has them', () => {
      writeModelsConfig({
        providers: {
          withHeaders: {
            baseUrl: 'http://test.com',
            apiKey: 'key',
            headers: { 'X-Custom': 'value', Authorization: 'Bearer xyz' },
            models: [{ id: 'model-1', name: 'test' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('test');
      expect(result.headers).toEqual({ 'X-Custom': 'value', Authorization: 'Bearer xyz' });
      expect(result.env?.ANTHROPIC_CUSTOM_HEADERS).toBe(
        'X-Custom: value\nAuthorization: Bearer xyz'
      );
    });

    test('no headers field when provider has none', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('fast');
      expect(result.headers).toBeUndefined();
    });

    test('filters non-string custom header values', () => {
      writeModelsConfig({
        providers: {
          withHeaders: {
            baseUrl: 'http://test.com',
            apiKey: 'key',
            headers: { 'X-Custom': 'value', 'X-Bad': 123 },
            models: [{ id: 'model-1', name: 'test' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('test');
      expect(result.headers).toEqual({ 'X-Custom': 'value' });
      expect(result.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Custom: value');
    });

    test('skips unsafe custom headers and reports validation error', () => {
      writeModelsConfig({
        providers: {
          withHeaders: {
            baseUrl: 'http://test.com',
            apiKey: 'key',
            headers: {
              'X-Custom': 'value',
              'X:Bad': 'bad',
              'X-Newline': 'bad\nvalue',
              'X-Carriage': 'bad\rvalue',
            },
            models: [{ id: 'model-1', name: 'test' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('test');
      expect(result.headers).toEqual({ 'X-Custom': 'value' });
      expect(result.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Custom: value');
      expect(registry.getError()).toContain('names cannot contain colon or newlines');
      expect(registry.getError()).toContain('values cannot contain newlines');
    });

    test('skips custom headers with unsafe resolved values', () => {
      process.env.ARCHON_TEST_CLAUDE_HEADER = 'bad\nvalue';
      writeModelsConfig({
        providers: {
          withHeaders: {
            baseUrl: 'http://test.com',
            apiKey: 'key',
            headers: {
              'X-Custom': 'value',
              'X-Resolved': 'ARCHON_TEST_CLAUDE_HEADER',
            },
            models: [{ id: 'model-1', name: 'test' }],
          },
        },
      });
      const registry = new ClaudeModelRegistry();
      const result = registry.resolve('test');

      expect(result.headers).toEqual({ 'X-Custom': 'value' });
      expect(result.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Custom: value');
    });
  });

  describe('getAll', () => {
    test('returns all models across all providers', () => {
      writeModelsConfig(SAMPLE_CONFIG);
      const registry = new ClaudeModelRegistry();
      const all = registry.getAll();
      expect(all).toHaveLength(4);
      expect(all[0]).toEqual({
        providerName: 'acme',
        model: { id: 'acme/fast-model-v2', name: 'fast' },
      });
      expect(all[3]).toEqual({
        providerName: 'local',
        model: { id: 'llama3.1:8b', name: 'llama' },
      });
    });

    test('returns empty when no file exists', () => {
      const registry = new ClaudeModelRegistry();
      expect(registry.getAll()).toEqual([]);
    });
  });
});
