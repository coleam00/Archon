import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { trackTempRoots } from '@archon/paths/test-utils';

import { buildCustomProviderModelsPath, getUserModelsPath } from './request-auth';

// pi 0.84.0+ ships `ModelRuntime.create({ modelsPath })` as the documented
// seam for changing the `models.json` location. The test exercises the
// pre-substitution step that writes a per-call `models.json` against a
// stubbed user models.json (the same shape Pi's `ModelConfig.load` reads).
// We assert the contract — substitution semantics, protected-env handling,
// missing-file / missing-provider fallthrough — not the SDK's.

// Every test points tmpdir() at a root it owns, so the per-call files
// buildCustomProviderModelsPath writes (and the fixture dirs below) are
// removed with that root instead of piling up in the real tmpdir.
// node:os tmpdir() reads TMPDIR on POSIX and TMP/TEMP on Windows.
const trackTempRoot = trackTempRoots();
const TMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;
const originalTmpEnv = TMP_ENV_KEYS.map(key => process.env[key]);
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
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-pi-request-auth-')));
    for (const key of TMP_ENV_KEYS) process.env[key] = root;
    process.env.PI_CODING_AGENT_DIR = '/nonexistent';
  });

  afterEach(() => {
    TMP_ENV_KEYS.forEach((key, i) => restoreEnv(key, originalTmpEnv[i]));
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

  test('substitutes protected ${VAR} references with a host-env-independent placeholder', () => {
    createUserModelsDir('${GH_TOKEN}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { GH_TOKEN: 'acting-user-secret' },
      protectedEnvKeys: ['GH_TOKEN'],
    });
    // Protected refs ARE substituted into the per-call file — but with a
    // structurally-valid placeholder (one identifier the SDK parses as an
    // env reference) that is provably absent from both requestEnv and
    // process.env. The SDK's own resolver then fails at request time with
    // `Failed to resolve API key from environment variable:
    // __ARCHON_BLOCKED_GH_TOKEN__` — the failure is host-environment-
    // independent, no matter what GH_TOKEN is set to in the shell.
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('${__ARCHON_BLOCKED_GH_TOKEN__}');
    // The literal protected value must never appear in the file.
    expect(written.providers.mygw.apiKey).not.toContain('acting-user-secret');
    expect(written.providers.mygw.apiKey).not.toMatch(/(?<!__ARCHON_BLOCKED_)GH_TOKEN/);
  });

  test('protected ${VAR} in header is also placeholder-substituted', () => {
    createUserModelsDir('key-${GH_TOKEN}', { Authorization: 'Bearer ${GH_TOKEN}' });
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { GH_TOKEN: 'acting-user-secret' },
      protectedEnvKeys: ['GH_TOKEN'],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('key-${__ARCHON_BLOCKED_GH_TOKEN__}');
    expect(written.providers.mygw.headers).toEqual({
      Authorization: 'Bearer ${__ARCHON_BLOCKED_GH_TOKEN__}',
    });
    expect(JSON.stringify(written.providers.mygw)).not.toContain('acting-user-secret');
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
    createUserModelsDir('$!bang ${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'token-2' },
      protectedEnvKeys: [],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('!bang token-2');
  });

  test('treats an empty-string env value as missing (template survives for the SDK error)', () => {
    // Mirrors the SDK's own resolver (`env?.[name] || process.env[name] ||
    // undefined`): an empty string falls through like a missing var. Writing
    // `apiKey: ""` instead would fail the SDK's minLength schema and silently
    // drop the whole provider ("Unknown provider") rather than surfacing the
    // SDK's actionable resolve error.
    createUserModelsDir('${MYGW_API_KEY}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: '' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
  });

  test('protected ref keeps its placeholder even when an unrelated missing ref shares the field', () => {
    // Regression for the R4 review finding: the missing-ref bail-out used to
    // discard the already-computed placeholder and return the ORIGINAL
    // template — no per-call file was written at all, and the SDK fell back
    // to the user's unmodified models.json, silently no-opping the
    // protected-key defense in exactly the combination it exists to catch.
    createUserModelsDir('${GH_TOKEN}${MISSING_VAR}');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { GH_TOKEN: 'acting-user-secret' },
      protectedEnvKeys: ['GH_TOKEN'],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    // The placeholder survives; the merely-missing ref stays template text so
    // the SDK still reports it. The literal protected value never appears.
    expect(written.providers.mygw.apiKey).toBe('${__ARCHON_BLOCKED_GH_TOKEN__}${MISSING_VAR}');
    expect(JSON.stringify(written)).not.toContain('acting-user-secret');
  });

  test('protected ref in one field is blocked even when another field has a missing ref', () => {
    createUserModelsDir('${GH_TOKEN}', { 'X-Extra': '${MISSING_VAR}' });
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { GH_TOKEN: 'acting-user-secret' },
      protectedEnvKeys: ['GH_TOKEN'],
    });
    expect(result).toBeDefined();
    const written = readModelsJson(result as string);
    expect(written.providers.mygw.apiKey).toBe('${__ARCHON_BLOCKED_GH_TOKEN__}');
    // The other field's unresolvable template is carried through unchanged.
    expect(written.providers.mygw.headers).toEqual({ 'X-Extra': '${MISSING_VAR}' });
    expect(JSON.stringify(written)).not.toContain('acting-user-secret');
  });

  test('tilde-prefixed PI_CODING_AGENT_DIR is expanded like the SDK expands it', () => {
    // Regression for the R3 review finding: without tilde expansion the
    // existsSync probe hits a literal `~/` path, substitution is skipped, and
    // the SDK (whose own getAgentDir DOES expand) reads the real models.json
    // with process.env fallback — silently reverting the fix this module
    // exists for. Asserted on the exported path resolver directly: bun's
    // os.homedir() cannot be redirected at runtime, so a filesystem-level
    // fake home is not scriptable here.
    process.env.PI_CODING_AGENT_DIR = '~/custom-agent';
    expect(getUserModelsPath()).toBe(join(homedir(), 'custom-agent', 'models.json'));

    process.env.PI_CODING_AGENT_DIR = '/absolute/agent-dir';
    expect(getUserModelsPath()).toBe(join('/absolute/agent-dir', 'models.json'));

    delete process.env.PI_CODING_AGENT_DIR;
    expect(getUserModelsPath()).toBe(join(homedir(), '.pi', 'agent', 'models.json'));
  });

  test('leaves command-form values (`!cmd`) untouched even when they contain $VAR text', () => {
    // A raw value starting with `!` is a COMMAND to the SDK
    // (parseConfigValueReference), executed at request time without template
    // substitution. Pre-substituting `$VAR` text inside the command string
    // would change what the command runs.
    createUserModelsDir('!get-key --account $MYGW_API_KEY');
    const result = buildCustomProviderModelsPath({
      provider: 'mygw',
      requestEnv: { MYGW_API_KEY: 'request-secret' },
      protectedEnvKeys: [],
    });
    expect(result).toBeUndefined();
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
  ])(
    'does not expose literal value of protected %s to custom provider config',
    credentialEnvKey => {
      // User config: `$$<KEY>` parses to a literal `$` followed by an env
      // reference to the credential var. The credential var is protected.
      createUserModelsDir(`$${credentialEnvKey}`);
      const result = buildCustomProviderModelsPath({
        provider: 'mygw',
        requestEnv: { [credentialEnvKey]: 'acting-user-secret' },
        protectedEnvKeys: [credentialEnvKey],
      });
      // Two layered guarantees for the security contract:
      //  (1) The per-call file must NEVER contain the literal protected value
      //      (`acting-user-secret`). Verified below — this is the round-2
      //      review's regression-critical assertion.
      //  (2) The file either contains no protected value (no `${VAR}` in the
      //      user template) and we return undefined, OR the per-call file
      //      contains a placeholder the SDK cannot resolve (covered by the
      //      `${GH_TOKEN}` test above). Either way, no path the SDK walks
      //      can produce the protected value from the per-call file.
      if (result !== undefined) {
        const written = JSON.stringify(readModelsJson(result));
        expect(written).not.toContain('acting-user-secret');
      }
    }
  );

  test('honours PI_CODING_AGENT_DIR override for the user models.json path', () => {
    const customDir = mkdtempSync(join(tmpdir(), 'archon-pi-user-models-custom-'));
    writeFileSync(
      join(customDir, 'models.json'),
      JSON.stringify({ providers: { mygw: { apiKey: 'prefix-${MYGW_API_KEY}' } } })
    );
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
