import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { buildCleanSubprocessEnv, SUBPROCESS_ENV_ALLOWLIST } from './env-allowlist';

describe('buildCleanSubprocessEnv', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('includes allowlisted vars present in process.env', () => {
    process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
    const env = buildCleanSubprocessEnv();
    expect(env.CLAUDE_USE_GLOBAL_AUTH).toBe('true');
  });

  it('excludes ANTHROPIC_API_KEY (not in allowlist)', () => {
    process.env.ANTHROPIC_API_KEY = 'leaked-key-from-target-repo';
    const env = buildCleanSubprocessEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('excludes arbitrary target-repo vars', () => {
    process.env.MY_APP_SECRET = 'should-not-leak';
    process.env.POSTGRES_PASSWORD = 'db-secret';
    const env = buildCleanSubprocessEnv();
    expect(env.MY_APP_SECRET).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
  });

  it('includes PATH and HOME (system essentials)', () => {
    const env = buildCleanSubprocessEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('includes GITHUB_TOKEN when present', () => {
    process.env.GITHUB_TOKEN = 'ghp_test123';
    const env = buildCleanSubprocessEnv();
    expect(env.GITHUB_TOKEN).toBe('ghp_test123');
  });

  it('includes OPENAI auth vars when present', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://api.example.com/v1';
    const env = buildCleanSubprocessEnv();
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.OPENAI_BASE_URL).toBe('https://api.example.com/v1');
  });

  it('does not include keys with undefined values', () => {
    const env = buildCleanSubprocessEnv();
    for (const value of Object.values(env)) {
      expect(value).not.toBeUndefined();
    }
  });
});

describe('SUBPROCESS_ENV_ALLOWLIST', () => {
  it('does not contain ANTHROPIC_API_KEY', () => {
    expect(SUBPROCESS_ENV_ALLOWLIST.has('ANTHROPIC_API_KEY')).toBe(false);
  });

  it('does not contain DATABASE_URL', () => {
    expect(SUBPROCESS_ENV_ALLOWLIST.has('DATABASE_URL')).toBe(false);
  });

  it('contains CLAUDE_API_KEY', () => {
    expect(SUBPROCESS_ENV_ALLOWLIST.has('CLAUDE_API_KEY')).toBe(true);
  });

  it('contains OPENAI_API_KEY', () => {
    expect(SUBPROCESS_ENV_ALLOWLIST.has('OPENAI_API_KEY')).toBe(true);
  });
});
