import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { stripCwdEnv } from './strip-cwd-env';

describe('stripCwdEnv', () => {
  const tmpDir = join(import.meta.dir, '__strip-cwd-env-test-tmp__');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_STRIP_KEY;
    delete process.env.TEST_STRIP_KEY2;
    delete process.env.TEST_STRIP_KEY_A;
    delete process.env.TEST_STRIP_KEY_B;
    // Clean up nested-session marker test keys
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.NODE_OPTIONS;
    delete process.env.VSCODE_INSPECTOR_OPTIONS;
  });

  it('strips keys from single .env file', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('strips keys from all four Bun-auto-loaded files', () => {
    for (const f of ['.env', '.env.local', '.env.development', '.env.production']) {
      writeFileSync(join(tmpDir, f), 'TEST_STRIP_KEY=leaked\n');
    }
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('does nothing when no CWD .env files exist', () => {
    process.env.TEST_STRIP_KEY = 'safe';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBe('safe');
  });

  it('preserves keys not in CWD .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    process.env.TEST_STRIP_KEY2 = 'preserved';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
    expect(process.env.TEST_STRIP_KEY2).toBe('preserved');
  });

  it('tolerates malformed .env lines', () => {
    writeFileSync(join(tmpDir, '.env'), 'NOTAKEYVALUE\nTEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
  });

  it('does not delete key if it was not in process.env (no-op)', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=parsed\n');
    // Do NOT set process.env.TEST_STRIP_KEY — simulate key parsed but not auto-loaded
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined(); // still undefined, no error
  });

  it('strips distinct keys from different .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY_A=leaked\n');
    writeFileSync(join(tmpDir, '.env.local'), 'TEST_STRIP_KEY_B=leaked\n');
    process.env.TEST_STRIP_KEY_A = 'leaked';
    process.env.TEST_STRIP_KEY_B = 'leaked';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY_A).toBeUndefined();
    expect(process.env.TEST_STRIP_KEY_B).toBeUndefined();
  });
});

describe('stripCwdEnv — operator logging (#1302)', () => {
  const tmpDir = join(import.meta.dir, '__strip-cwd-env-log-test-tmp__');
  let stderrSpy: ReturnType<typeof spyOn>;
  let stderrWrites: string[];

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    stderrWrites = [];
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_STRIP_LOG_A;
    delete process.env.TEST_STRIP_LOG_B;
    delete process.env.TEST_STRIP_LOG_C;
  });

  it('emits [archon] stripped line with count and filename when keys are stripped', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_LOG_A=leaked\nTEST_STRIP_LOG_B=leaked\n');
    process.env.TEST_STRIP_LOG_A = 'leaked';
    process.env.TEST_STRIP_LOG_B = 'leaked';
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeDefined();
    expect(line).toContain('stripped 2 keys');
    expect(line).toContain(tmpDir);
    expect(line).toContain('(.env)');
  });

  it('lists every contributing filename when keys span multiple .env files', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_LOG_A=leaked\n');
    writeFileSync(join(tmpDir, '.env.local'), 'TEST_STRIP_LOG_B=leaked\n');
    process.env.TEST_STRIP_LOG_A = 'leaked';
    process.env.TEST_STRIP_LOG_B = 'leaked';
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeDefined();
    expect(line).toContain('(.env, .env.local)');
  });

  it('emits no [archon] stripped line when no CWD .env files exist', () => {
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeUndefined();
  });

  it('emits no [archon] stripped line when .env file is empty', () => {
    writeFileSync(join(tmpDir, '.env'), '');
    stripCwdEnv(tmpDir);
    const line = stderrWrites.find(s => s.startsWith('[archon] stripped'));
    expect(line).toBeUndefined();
  });
});

describe('stripCwdEnv — nested Claude Code marker stripping', () => {
  const tmpDir = join(import.meta.dir, '__strip-markers-test-tmp__');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_EXECPATH;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_HIDE_ACCOUNT_INFO;
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.NODE_OPTIONS;
    delete process.env.VSCODE_INSPECTOR_OPTIONS;
  });

  it('strips CLAUDECODE from process.env', () => {
    process.env.CLAUDECODE = '1';
    stripCwdEnv(tmpDir);
    expect(process.env.CLAUDECODE).toBeUndefined();
  });

  it('strips CLAUDE_CODE_* session markers', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_EXECPATH = '/usr/local/bin/claude';
    process.env.CLAUDE_CODE_NO_FLICKER = '1';
    process.env.CLAUDE_CODE_HIDE_ACCOUNT_INFO = '1';
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    stripCwdEnv(tmpDir);
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(process.env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(process.env.CLAUDE_CODE_NO_FLICKER).toBeUndefined();
    expect(process.env.CLAUDE_CODE_HIDE_ACCOUNT_INFO).toBeUndefined();
    expect(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
  });

  it('preserves CLAUDE_CODE_* auth vars', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-secret';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    stripCwdEnv(tmpDir);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-secret');
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(process.env.CLAUDE_CODE_USE_VERTEX).toBe('1');
  });

  it('strips NODE_OPTIONS and VSCODE_INSPECTOR_OPTIONS', () => {
    process.env.NODE_OPTIONS = '--inspect';
    process.env.VSCODE_INSPECTOR_OPTIONS = '{"port":9229}';
    stripCwdEnv(tmpDir);
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.VSCODE_INSPECTOR_OPTIONS).toBeUndefined();
  });

  it('handles combined CWD .env + nested session markers in one call', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_STRIP_KEY=leaked\n');
    process.env.TEST_STRIP_KEY = 'leaked';
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'keep-me';
    stripCwdEnv(tmpDir);
    expect(process.env.TEST_STRIP_KEY).toBeUndefined();
    expect(process.env.CLAUDECODE).toBeUndefined();
    expect(process.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('keep-me');
  });
});
