/**
 * Integration tests for the env isolation flow:
 *   Bun auto-load (simulated) → stripCwdEnv() → ~/.archon/.env load → subprocess env
 *
 * Tests the full user scenario: what keys reach the Claude subprocess when the
 * user has various combinations of CWD .env, ~/.archon/.env, and shell env?
 *
 * Note: We can't actually test Bun's auto-load (it runs before any code), so we
 * simulate it by setting process.env keys before calling stripCwdEnv(). This is
 * equivalent — Bun's auto-load just does process.env[key] = value, same as us.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import { stripCwdEnv } from './strip-cwd-env';

// Track all test keys so afterEach can clean them up reliably
const TEST_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_USE_GLOBAL_AUTH',
  'DATABASE_URL',
  'LOG_LEVEL',
  'CWD_ONLY_KEY',
  'ARCHON_ONLY_KEY',
  'SHARED_KEY',
  'MY_SECRET_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'NODE_OPTIONS',
  'REDIS_URL',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'MANAGED_SECRET',
];

describe('env isolation integration', () => {
  const cwdDir = join(import.meta.dir, '__env-integration-cwd__');
  const archonDir = join(import.meta.dir, '__env-integration-archon__');
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original env state
    savedEnv = {};
    for (const key of TEST_KEYS) {
      savedEnv[key] = process.env[key];
    }
    mkdirSync(cwdDir, { recursive: true });
    mkdirSync(archonDir, { recursive: true });
  });

  afterEach(() => {
    // Restore original env
    for (const key of TEST_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(archonDir, { recursive: true, force: true });
  });

  /**
   * Simulate the full entry-point flow:
   * 1. "Bun auto-load" (set CWD .env keys in process.env)
   * 2. stripCwdEnv() (remove CWD keys + markers)
   * 3. Load ~/.archon/.env (dotenv.config)
   * 4. Return process.env snapshot (what buildSubprocessEnv would return)
   */
  function simulateEntryPointFlow(cwdEnv: string, archonEnv: string): NodeJS.ProcessEnv {
    // Write the CWD .env file
    writeFileSync(join(cwdDir, '.env'), cwdEnv);

    // Simulate Bun auto-load: parse CWD .env and set in process.env
    const cwdParsed = config({ path: join(cwdDir, '.env'), processEnv: {} });
    if (cwdParsed.parsed) {
      for (const [key, value] of Object.entries(cwdParsed.parsed)) {
        process.env[key] = value;
      }
    }

    // Step 2: stripCwdEnv (same as entry point)
    stripCwdEnv(cwdDir);

    // Step 3: Load ~/.archon/.env with override — user's Archon config wins
    // over any shell-inherited vars (same as real entry point).
    writeFileSync(join(archonDir, '.env'), archonEnv);
    config({ path: join(archonDir, '.env'), override: true });

    // Step 4: Return subprocess env snapshot
    return { ...process.env };
  }

  it('scenario 1: global auth user with ANTHROPIC_API_KEY in CWD .env — CWD key stripped', () => {
    // User ran `claude /login` (global auth). Target repo has ANTHROPIC_API_KEY
    // in its .env. That key must NOT reach the subprocess.
    const subprocessEnv = simulateEntryPointFlow(
      'ANTHROPIC_API_KEY=sk-target-repo-leaked\nDATABASE_URL=postgres://target/db\n',
      'CLAUDE_USE_GLOBAL_AUTH=true\n'
    );

    expect(subprocessEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(subprocessEnv.DATABASE_URL).toBeUndefined();
    expect(subprocessEnv.CLAUDE_USE_GLOBAL_AUTH).toBe('true');
  });

  it('scenario 2: user has OAuth token in archon env + random key in CWD .env — CWD stripped, archon kept', () => {
    const subprocessEnv = simulateEntryPointFlow(
      'CWD_ONLY_KEY=from-target-repo\nLOG_LEVEL=debug\n',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-my-token\nCLAUDE_USE_GLOBAL_AUTH=false\n'
    );

    // CWD keys must be gone
    expect(subprocessEnv.CWD_ONLY_KEY).toBeUndefined();
    expect(subprocessEnv.LOG_LEVEL).toBeUndefined();
    // Archon keys must be present
    expect(subprocessEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-my-token');
    expect(subprocessEnv.CLAUDE_USE_GLOBAL_AUTH).toBe('false');
  });

  it('scenario 3: nothing from CWD .env leaks to subprocess', () => {
    const subprocessEnv = simulateEntryPointFlow(
      'MY_SECRET_TOKEN=leaked\nDATABASE_URL=postgres://wrong/db\nLOG_LEVEL=trace\nANTHROPIC_API_KEY=sk-wrong-key\n',
      'ARCHON_ONLY_KEY=trusted\n'
    );

    // ALL CWD keys must be gone
    expect(subprocessEnv.MY_SECRET_TOKEN).toBeUndefined();
    expect(subprocessEnv.DATABASE_URL).toBeUndefined();
    expect(subprocessEnv.LOG_LEVEL).toBeUndefined();
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBeUndefined();
    // Archon key present
    expect(subprocessEnv.ARCHON_ONLY_KEY).toBe('trusted');
    // Shell-inherited keys present (Windows uses "Path" casing and USERPROFILE instead of HOME)
    const hasPath = subprocessEnv.PATH ?? subprocessEnv.Path;
    expect(hasPath).toBeDefined();
    const hasHome = subprocessEnv.HOME ?? subprocessEnv.USERPROFILE;
    expect(hasHome).toBeDefined();
  });

  it('scenario 4: same key in both CWD and archon env — archon value wins', () => {
    // User has ANTHROPIC_API_KEY in both places. CWD one is the target repo's,
    // archon one is the user's intentional config. Archon must win.
    const subprocessEnv = simulateEntryPointFlow(
      'ANTHROPIC_API_KEY=sk-target-repo-WRONG\nSHARED_KEY=cwd-value\n',
      'ANTHROPIC_API_KEY=sk-my-real-key\nSHARED_KEY=archon-value\n'
    );

    // Archon value wins (CWD was stripped, then archon loaded)
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBe('sk-my-real-key');
    expect(subprocessEnv.SHARED_KEY).toBe('archon-value');
  });

  it('CLAUDECODE markers stripped even if not from CWD .env', () => {
    // Simulating: parent Claude Code shell sets CLAUDECODE=1
    // (not from .env file, from inherited shell env)
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.NODE_OPTIONS = '--inspect';

    const subprocessEnv = simulateEntryPointFlow('', '');

    expect(subprocessEnv.CLAUDECODE).toBeUndefined();
    expect(subprocessEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(subprocessEnv.NODE_OPTIONS).toBeUndefined();
  });

  it('scenario 5: DATABASE_URL in CWD .env does not reach Archon — archon uses its own DB', () => {
    // Target repo has DATABASE_URL for its own PostgreSQL. Archon must NOT
    // connect to the target app's database — it should use its own DB
    // (from ~/.archon/.env or default SQLite).
    const subprocessEnv = simulateEntryPointFlow(
      'DATABASE_URL=postgresql://target-app:5432/wrong_db\nREDIS_URL=redis://target:6379\n',
      'DATABASE_URL=sqlite:///Users/me/.archon/archon.db\n'
    );

    // CWD DATABASE_URL is stripped, archon's wins
    expect(subprocessEnv.DATABASE_URL).toBe('sqlite:///Users/me/.archon/archon.db');
    // Other CWD keys also stripped
    expect(subprocessEnv.REDIS_URL).toBeUndefined();
  });

  it('scenario 6: DATABASE_URL in CWD .env only (no archon env) — stripped entirely', () => {
    // User relies on default SQLite (no DATABASE_URL in ~/.archon/.env).
    // Target repo's DATABASE_URL must not leak.
    const subprocessEnv = simulateEntryPointFlow(
      'DATABASE_URL=postgresql://target-app:5432/production\n',
      ''
    );

    expect(subprocessEnv.DATABASE_URL).toBeUndefined();
  });

  it('CLAUDE_CODE_OAUTH_TOKEN from archon env survives marker strip', () => {
    // CLAUDE_CODE_* markers are stripped, but CLAUDE_CODE_OAUTH_TOKEN is
    // an auth var and must be preserved.
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

    const subprocessEnv = simulateEntryPointFlow(
      '',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-keep-this\n'
    );

    expect(subprocessEnv.CLAUDECODE).toBeUndefined();
    expect(subprocessEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(subprocessEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-keep-this');
  });

  // ── Multiple .env file variants ────────────────────────────────────────

  /** Simulate Bun auto-loading a specific .env file into process.env. */
  function simulateBunAutoLoad(filePath: string): void {
    const parsed = config({ path: filePath, processEnv: {} });
    if (parsed.parsed) {
      for (const [key, value] of Object.entries(parsed.parsed)) {
        process.env[key] = value;
      }
    }
  }

  it('strips keys from .env.local in addition to .env', () => {
    // Bun auto-loads .env.local too — keys from there must also be stripped
    writeFileSync(join(cwdDir, '.env.local'), 'OPENAI_API_KEY=sk-local-leaked\n');
    simulateBunAutoLoad(join(cwdDir, '.env.local'));

    const subprocessEnv = simulateEntryPointFlow(
      'ANTHROPIC_API_KEY=sk-main-leaked\n',
      'CLAUDE_USE_GLOBAL_AUTH=true\n'
    );

    expect(subprocessEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(subprocessEnv.OPENAI_API_KEY).toBeUndefined();
    expect(subprocessEnv.CLAUDE_USE_GLOBAL_AUTH).toBe('true');
  });

  it('strips keys from .env.development', () => {
    writeFileSync(join(cwdDir, '.env.development'), 'ELEVENLABS_API_KEY=el-dev-leaked\n');
    simulateBunAutoLoad(join(cwdDir, '.env.development'));

    const subprocessEnv = simulateEntryPointFlow('', '');

    expect(subprocessEnv.ELEVENLABS_API_KEY).toBeUndefined();
  });

  // ── Shell-inherited env preservation ───────────────────────────────────

  it('preserves shell-inherited env that is not in CWD .env', () => {
    // User has SSH_AUTH_SOCK and HTTP_PROXY in their shell — these must survive
    // because they are not from the target repo's .env
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
    process.env.HTTP_PROXY = 'http://proxy.corp:8080';

    const subprocessEnv = simulateEntryPointFlow('ANTHROPIC_API_KEY=sk-leaked\n', '');

    // CWD key stripped
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBeUndefined();
    // Shell-inherited env preserved (not in any CWD .env file)
    expect(subprocessEnv.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
    expect(subprocessEnv.HTTP_PROXY).toBe('http://proxy.corp:8080');
  });

  it('strips shell-inherited env if same key also appears in CWD .env', () => {
    // If SSH_AUTH_SOCK is in both shell AND CWD .env, the CWD value is what
    // Bun auto-loaded — stripping removes it. This is correct behavior:
    // the CWD .env overwrote the shell value during auto-load.
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';

    const subprocessEnv = simulateEntryPointFlow('SSH_AUTH_SOCK=/tmp/repo-evil-agent.sock\n', '');

    // Key was in CWD .env, so it gets stripped entirely
    expect(subprocessEnv.SSH_AUTH_SOCK).toBeUndefined();
  });

  // ── Bedrock/Vertex auth preservation ───────────────────────────────────

  it('preserves CLAUDE_CODE_USE_BEDROCK and CLAUDE_CODE_USE_VERTEX', () => {
    // These are CLAUDE_CODE_* vars but are auth-related — must survive marker strip
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

    const subprocessEnv = simulateEntryPointFlow(
      '',
      'CLAUDE_CODE_USE_BEDROCK=1\nCLAUDE_CODE_USE_VERTEX=1\nCLAUDE_CODE_OAUTH_TOKEN=sk-token\n'
    );

    // Markers stripped
    expect(subprocessEnv.CLAUDECODE).toBeUndefined();
    expect(subprocessEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    // Auth vars preserved
    expect(subprocessEnv.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(subprocessEnv.CLAUDE_CODE_USE_VERTEX).toBe('1');
    expect(subprocessEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-token');
  });

  // ── Managed execution env (simulated) ──────────────────────────────────

  it('managed execution env merges on top of clean process.env', () => {
    // After the entry point flow, the workflow executor merges managed env
    // (from config.yaml env: + DB vars) on top of process.env.
    // This simulates that final merge.
    const subprocessEnv = simulateEntryPointFlow(
      'ANTHROPIC_API_KEY=sk-leaked\nDATABASE_URL=postgres://wrong\n',
      'CLAUDE_USE_GLOBAL_AUTH=true\n'
    );

    // Simulate managed env merge (what dag-executor does via requestOptions.env)
    const managedEnv = { MANAGED_SECRET: 'from-db', ELEVENLABS_API_KEY: 'el-managed' };
    const finalEnv = { ...subprocessEnv, ...managedEnv };

    // CWD keys still stripped
    expect(finalEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(finalEnv.DATABASE_URL).toBeUndefined();
    // Archon auth present
    expect(finalEnv.CLAUDE_USE_GLOBAL_AUTH).toBe('true');
    // Managed env present
    expect(finalEnv.MANAGED_SECRET).toBe('from-db');
    expect(finalEnv.ELEVENLABS_API_KEY).toBe('el-managed');
    // OS essentials present
    expect(finalEnv.PATH ?? finalEnv.Path).toBeDefined();
  });
});
