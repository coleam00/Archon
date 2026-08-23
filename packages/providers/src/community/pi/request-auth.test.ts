import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCustomProviderModelsPath } from './request-auth';

// pi 0.84.0+ ships `ModelRuntime.create({ modelsPath })` as the documented
// seam for changing the `models.json` location. The test exercises the
// pre-substitution step that writes a per-call `models.json` against a
// stubbed user models.json (the same shape Pi's `ModelConfig.load` reads).
// We assert the contract — substitution semantics, protected-env handling,
// missing-file / missing-provider fallthrough — not the SDK's.

const createdDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalCopilotToken = process.env.COPILOT_GITHUB_TOKEN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createUserModelsDir(apiKeyTemplate?: string, headers?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-'));
  const provider: Record<string, unknown> = {
    baseUrl: 'https://gateway.example/v1',
    api: 'openai-completions',
    models: [{ id: 'demo' }],
  };
  if (apiKeyTemplate !== undefined) provider.apiKey = apiKeyTemplate;
  if (headers !== undefined) provider.headers = headers;
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mygw: provider } }));
  createdDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function readModelsJson(path: string): { providers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(path, 'utf-8')) as {
    providers: Record<string, Record<string, unknown>>;
  };
}

describe('buildCustomProviderModelsPath', () => {
  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = '/nonexistent';
  });

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    restoreEnv('PI_CODING_AGENT_DIR', originalAgentDir);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey);
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
    restoreEnv('GH_TOKEN', originalGhToken);
    restoreEnv('GITHUB_TOKEN', originalGithubToken);
    restoreEnv('COPILOT_GITHUB_TOKEN', originalCopilotToken);
  });

  test('substitutes ${VAR} in apiKey and headers against requestEnv', () => {
    createUserModelsDir('prefix-${MYGW_API_KEY}', { 'X-Project': '${MYGW_PROJECT}' });
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: {
        MYGW_API_KEY: 'request-secret',
        MYGW_PROJECT: 'project-123',
      },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('archon-pi-models');
    expect(existsSync(result as string)).toBe(true);
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('prefix-request-secret');
    expect(written.providers.mygw.headers).toEqual({ 'X-Project': 'project-123' });
    // Untouched fields preserved.
    expect(written.providers.mygw.baseUrl).toBe('https://gateway.example/v1');
    expect(written.providers.mygw.api).toBe('openai-completions');
    expect(written.providers.mygw.models).toEqual([{ id: 'demo' }]);
  });

  test('returns undefined when requestEnv is undefined', () => {
    createUserModelsDir('prefix-${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: undefined,
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined when user models.json does not exist', () => {
    process.env.PI_CODING_AGENT_DIR = '/definitely/does/not/exist';
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'request-secret' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined when provider is not in models.json', () => {
    createUserModelsDir('prefix-${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'nonexistent',
      requestEnv: { MYGW_API_KEY: 'request-secret' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined when apiKey has no template references and no header templates', () => {
    // Literal apiKey + no headers — nothing to substitute, so writing a
    // per-call file gains nothing; the SDK's default lookup handles it.
    createUserModelsDir('literal-key');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'request-secret' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('does not substitute protected ${VAR} references', () => {
    createUserModelsDir('${GH_TOKEN}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { GH_TOKEN: 'acting-user-secret' },
      protectedEnvKeys: ['GH_TOKEN'],
    });
    // No substitution happened (the protected reference was skipped, leaving
    // nothing to write), so the per-call file is NOT produced — the SDK's
    // default `modelsPath` lookup will load the user's `models.json` with
    // `${GH_TOKEN}` intact, and Pi's own resolveConfigValue surfaces the
    // standard "no value for env var" error at request time.
    expect(result).toBeUndefined();
  });

  test('does not substitute ${VAR} references absent from requestEnv', () => {
    createUserModelsDir('prefix-${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { OTHER_VAR: 'some-value' },
      protectedEnvKeys: [],
    });
    // Missing-reference path: leave template unchanged; SDK surface its
    // own "Failed to resolve from environment variable" error.
    expect(result).toBeUndefined();
  });

  test('handles $$ escape (literal $)', () => {
    createUserModelsDir('price=$$5.00 ${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'token-1' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('price=$5.00 token-1');
  });

  test('handles $! escape (literal !)', () => {
    createUserModelsDir('!bang ${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'token-2' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('!bang token-2');
  });

  test('handles ${VAR} brace form', () => {
    createUserModelsDir('${MYGW_API_KEY}-suffix');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'token-3' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('token-3-suffix');
  });

  test('substitutes mixed literal+env header values, leaves non-template headers alone', () => {
    createUserModelsDir('key-${MYGW_API_KEY}', {
      'X-Project': '${MYGW_PROJECT}',
      'X-Static': 'literal-value',
    });
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'token-4', MYGW_PROJECT: 'proj-x' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('key-token-4');
    expect(written.providers.mygw.headers).toEqual({
      'X-Project': 'proj-x',
      'X-Static': 'literal-value',
    });
  });

  test('returns undefined when only non-string header values are present', () => {
    createUserModelsDir('literal-key', { 'X-Project': 42 as unknown as string });
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'ignored' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'COPILOT_GITHUB_TOKEN',
  ])('does not expose protected %s to custom provider config', credentialEnvKey => {
    createUserModelsDir(`$${credentialEnvKey}`);
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { [credentialEnvKey]: 'acting-user-secret' },
      protectedEnvKeys: [credentialEnvKey],
    });
    // Per the security contract, protected `${VAR}` references are NEVER
    // substituted into the per-call file. The user models.json stays
    // untouched; Pi's own resolveConfigValue surfaces the standard
    // "no value for env var" error at request time (or succeeds if the
    // var happens to be in process.env, which Archon keeps empty).
    expect(result).toBeUndefined();
  });

  test('honours PI_CODING_AGENT_DIR override for the user models.json path', () => {
    const customDir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-custom-'));
    writeFileSync(
      join(customDir, 'models.json'),
      JSON.stringify({ providers: { mygw: { apiKey: 'prefix-${MYGW_API_KEY}' } } })
    );
    createdDirs.push(customDir);
    process.env.PI_CODING_AGENT_DIR = customDir;

    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'overridden-token' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('prefix-overridden-token');
  });

  test('tolerates a user models.json with multiple providers (only targets the scoped one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-multi-'));
    createdDirs.push(dir);
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          mygw: { apiKey: 'prefix-${MYGW_API_KEY}', api: 'openai-completions' },
          other: { apiKey: 'literal-other' },
        },
      })
    );
    process.env.PI_CODING_AGENT_DIR = dir;

    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'tok' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(Object.keys(written.providers)).toEqual(['mygw']);
    expect(written.providers.mygw.apiKey).toBe('prefix-tok');
  });

  test('returns undefined when user models.json is invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-broken-'));
    createdDirs.push(dir);
    writeFileSync(join(dir, 'models.json'), '{not-valid-json');
    process.env.PI_CODING_AGENT_DIR = dir;

    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'tok' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('handles malformed ${VAR (no closing brace) by leaving template literal', () => {
    // The SDK's parser treats an unterminated `${` as a literal `$`. Mirror
    // that behaviour here so we never disagree with the SDK on what a
    // template string means.
    createUserModelsDir('prefix-${UNCLOSED');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { UNCLOSED: 'value' },
      protectedEnvKeys: [],
    });
    // The literal `$` is in the apiKey, so `value.includes('$')` returns
    // true and we enter the parser; the parser keeps `$` literal, no env
    // references resolve, and we return undefined (no substitution
    // produced). Either outcome is acceptable as long as the SDK agrees.
    // Confirm we don't crash and don't produce a substituted value.
    if (result !== undefined) {
      const written = readModelsJson(result);
      expect(written.providers.mygw.apiKey).toBe('prefix-${UNCLOSED');
    }
  });

  test('handles ${1badname} (non-identifier) by treating as literal', () => {
    // The SDK's parser only treats `${IDENT}` (valid JS identifier) as an
    // env reference; anything else stays literal. Mirror that.
    createUserModelsDir('${1bad}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { '1bad': 'value' },
      protectedEnvKeys: [],
    });
    if (result !== undefined) {
      const written = readModelsJson(result);
      expect(written.providers.mygw.apiKey).toBe('${1bad}');
    }
  });

  test('handles trailing $ in template', () => {
    createUserModelsDir('end-with-dollar$');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'tok' },
      protectedEnvKeys: [],
    });
    // Trailing `$` with no following character → literal `$`.
    if (result !== undefined) {
      const written = readModelsJson(result);
      expect(written.providers.mygw.apiKey).toBe('end-with-dollar$');
    }
  });

  test('returns undefined when user models.json has no providers key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-noprov-'));
    createdDirs.push(dir);
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ unrelated: 'value' }));
    process.env.PI_CODING_AGENT_DIR = dir;

    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'tok' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('returns undefined when scoped provider entry is not an object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-nonobj-'));
    createdDirs.push(dir);
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({ providers: { mygw: 'not-an-object' } })
    );
    process.env.PI_CODING_AGENT_DIR = dir;

    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'tok' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });
});
