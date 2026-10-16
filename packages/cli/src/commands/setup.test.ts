/**
 * Tests for setup command utility functions
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { generateKeyPairSync } from 'node:crypto';
import * as git from '@archon/git';
import {
  GITHUB_APP_CREDENTIAL_KEYS,
  selectGitHubAuthMode,
} from '@archon/core/utils/github-auth-mode';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';
import {
  GITHUB_APP_KEYS,
  bootstrapProjectConfig,
  selectSetupProviders,
  collectAIConfig,
  checkExistingConfig,
  generateEnvContent,
  generateWebhookSecret,
  detectClaudeExecutablePath,
  writeScopedEnv,
  serializeEnv,
  resolveScopedEnvPath,
  writeHomePiModelConfig,
  buildDefaultModelChoices,
  readInstallDefaultModel,
  writeInstallDefaults,
  setupCommand,
} from './setup';
import * as setupModule from './setup';
import * as doctorModule from './doctor';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';
import { parse as parseDotenv } from 'dotenv';

// Test directory for file operations
const TEST_DIR = join(tmpdir(), 'archon-setup-test-' + Date.now());

describe('setup command', () => {
  beforeEach(() => {
    // Create test directory
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('generateWebhookSecret', () => {
    it('should generate a 64-character hex string', () => {
      const secret = generateWebhookSecret();

      expect(secret).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
    });

    it('should generate unique secrets each time', () => {
      const secret1 = generateWebhookSecret();
      const secret2 = generateWebhookSecret();

      expect(secret1).not.toBe(secret2);
    });
  });

  describe('checkExistingConfig', () => {
    it('should return null when no .env file exists', () => {
      // Mock ARCHON_HOME to point to non-existent directory
      const originalHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = join(TEST_DIR, 'nonexistent');

      const result = checkExistingConfig();

      expect(result).toBeNull();

      if (originalHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalHome;
      }
    });

    it('should detect existing configuration values', () => {
      const envDir = join(TEST_DIR, '.archon');
      mkdirSync(envDir, { recursive: true });
      const envPath = join(envDir, '.env');

      // Write a test .env file
      writeFileSync(
        envPath,
        `
CLAUDE_USE_GLOBAL_AUTH=true
TELEGRAM_BOT_TOKEN=123:ABC
ARCHON_CODEX_ID_TOKEN=token1
ARCHON_CODEX_ACCESS_TOKEN=token2
ARCHON_CODEX_REFRESH_TOKEN=token3
ARCHON_CODEX_ACCOUNT_ID=account1
`.trim()
      );

      const originalHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = envDir;

      const result = checkExistingConfig();

      expect(result).not.toBeNull();
      expect(result?.hasClaude).toBe(true);
      expect(result?.hasCodex).toBe(true);
      expect(result?.platforms.telegram).toBe(true);
      expect(result?.platforms.github).toBe(false);
      expect(result?.platforms.slack).toBe(false);

      if (originalHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalHome;
      }
    });

    it('counts an old Archon Codex setup, but not a lone CODEX_ACCESS_TOKEN (#3562)', () => {
      const envDir = join(TEST_DIR, '.archon-codex-legacy');
      mkdirSync(envDir, { recursive: true });
      const envPath = join(envDir, '.env');

      writeFileSync(
        envPath,
        'CODEX_ID_TOKEN=id\nCODEX_ACCESS_TOKEN=access\nCODEX_REFRESH_TOKEN=rt\nCODEX_ACCOUNT_ID=acct\n'
      );
      expect(checkExistingConfig(envPath)?.hasCodex).toBe(true);

      writeFileSync(envPath, 'CODEX_ACCESS_TOKEN=users-own\n');
      expect(checkExistingConfig(envPath)?.hasCodex).toBe(false);
    });

    it('detects existing Pi configuration from a Pi API key env var', () => {
      const envDir = join(TEST_DIR, '.archon-pi');
      mkdirSync(envDir, { recursive: true });
      const envPath = join(envDir, '.env');

      writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-ant-test\nDEFAULT_AI_ASSISTANT=pi\n');

      const result = checkExistingConfig(envPath);

      expect(result).not.toBeNull();
      expect(result?.hasPi).toBe(true);
      expect(result?.hasClaude).toBe(false);
      expect(result?.hasCodex).toBe(false);
    });
  });

  describe('generateEnvContent', () => {
    it('does not write a default when no assistant was selected', () => {
      const content = generateEnvContent({
        ai: { claude: false, codex: false, pi: false, defaultAssistant: undefined },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });
      expect(content).not.toContain('DEFAULT_AI_ASSISTANT=');
    });

    it('should generate valid .env content for SQLite configuration', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('# Using SQLite (default)');
      expect(content).toContain('CLAUDE_USE_GLOBAL_AUTH=true');
      expect(content).toContain('DEFAULT_AI_ASSISTANT=claude');
      // PORT is intentionally commented out — server and Vite both default to 3090 when unset (#1152).
      expect(content).toContain('# PORT=3090');
      expect(content).not.toMatch(/^PORT=/m);
      // Sanity: never emit an active DATABASE_URL line. The "# Set DATABASE_URL=..."
      // hint is a comment and is fine — only an unprefixed assignment would be wrong.
      expect(content).not.toMatch(/^DATABASE_URL=/m);
    });

    it('emits CLAUDE_BIN_PATH when claudeBinaryPath is configured', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          claudeBinaryPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });

      expect(content).toContain(
        'CLAUDE_BIN_PATH=/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      );
    });

    it('omits CLAUDE_BIN_PATH when not configured', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });

      expect(content).not.toContain('CLAUDE_BIN_PATH=');
    });

    it('should include platform configurations', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: true,
          telegram: true,
          slack: false,
        },
        github: {
          mode: 'pat',
          token: 'ghp_testtoken',
          webhookSecret: 'testsecret123',
          allowedUsers: 'user1,user2',
          botMention: 'mybot',
        },
        telegram: {
          botToken: '123:ABC',
          allowedUserIds: '111,222',
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('GH_TOKEN=ghp_testtoken');
      expect(content).toContain('GITHUB_TOKEN=ghp_testtoken');
      expect(content).toContain('WEBHOOK_SECRET=testsecret123');
      expect(content).toContain('GITHUB_ALLOWED_USERS=user1,user2');
      expect(content).toContain('GITHUB_BOT_MENTION=mybot');
      expect(content).toContain('TELEGRAM_BOT_TOKEN=123:ABC');
      expect(content).toContain('TELEGRAM_ALLOWED_USER_IDS=111,222');
      expect(content).toContain('TELEGRAM_STREAMING_MODE=stream');
    });

    it('should include Codex tokens when configured', () => {
      const content = generateEnvContent({
        ai: {
          claude: false,
          codex: true,
          pi: false,
          codexTokens: {
            idToken: 'id-token',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            accountId: 'account-id',
          },
          defaultAssistant: 'codex',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
        },
        botDisplayName: 'Archon',
      });

      // Codex reads CODEX_* itself, so Archon's copies must not use its names (#3562).
      const env = parseDotenv(content);
      expect(env).toMatchObject({
        ARCHON_CODEX_ID_TOKEN: 'id-token',
        ARCHON_CODEX_ACCESS_TOKEN: 'access-token',
        ARCHON_CODEX_REFRESH_TOKEN: 'refresh-token',
        ARCHON_CODEX_ACCOUNT_ID: 'account-id',
      });
      expect(Object.keys(env).filter(key => key.startsWith('CODEX_'))).toEqual([]);
      expect(content).toContain('DEFAULT_AI_ASSISTANT=codex');
    });

    it('should include custom bot display name', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
        },
        botDisplayName: 'MyCustomBot',
      });

      expect(content).toContain('BOT_DISPLAY_NAME=MyCustomBot');
    });

    it('should not include bot display name when default', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
        },
        botDisplayName: 'Archon',
      });

      expect(content).not.toContain('BOT_DISPLAY_NAME=');
    });

    it('should include Slack configuration', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: true,
        },
        slack: {
          botToken: 'xoxb-test',
          appToken: 'xapp-test',
          allowedUserIds: 'U123',
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('SLACK_BOT_TOKEN=xoxb-test');
      expect(content).toContain('SLACK_APP_TOKEN=xapp-test');
      expect(content).toContain('SLACK_ALLOWED_USER_IDS=U123');
      expect(content).toContain('SLACK_STREAMING_MODE=batch');
    });

    it('emits Pi API key when Pi is configured with API key', () => {
      const content = generateEnvContent({
        ai: {
          claude: false,
          codex: false,
          pi: true,
          piApiKey: 'sk-ant-test',
          piApiKeyEnvVar: 'ANTHROPIC_API_KEY',
          defaultAssistant: 'pi',
        },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-test');
      expect(content).toContain('DEFAULT_AI_ASSISTANT=pi');
      expect(content).not.toContain('# Pi not configured');
    });

    it('emits Pi placeholder comment when Pi is configured without API key', () => {
      const content = generateEnvContent({
        ai: { claude: false, codex: false, pi: true, defaultAssistant: 'pi' },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('# Pi configured');
      // No active ANTHROPIC_API_KEY assignment — the example appears only in a
      // commented-out hint.
      expect(content).not.toMatch(/^ANTHROPIC_API_KEY=/m);
      expect(content).toContain('DEFAULT_AI_ASSISTANT=pi');
    });

    it('emits "Pi not configured" comment when Pi is false', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: false,
          defaultAssistant: 'claude',
        },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('# Pi not configured');
      expect(content).not.toMatch(/^ANTHROPIC_API_KEY=/m);
    });

    it('generates valid content for mixed Claude+Pi setup', () => {
      const content = generateEnvContent({
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          pi: true,
          piApiKey: 'or-key',
          piApiKeyEnvVar: 'OPENROUTER_API_KEY',
          defaultAssistant: 'claude',
        },
        platforms: { github: false, telegram: false, slack: false },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('CLAUDE_USE_GLOBAL_AUTH=true');
      expect(content).toContain('OPENROUTER_API_KEY=or-key');
      expect(content).toContain('DEFAULT_AI_ASSISTANT=claude');
      expect(content).toContain('# Pi Authentication');
    });
  });

  describe('bootstrapProjectConfig', () => {
    it('creates .archon/config.yaml when it does not exist', () => {
      const target = join(TEST_DIR, 'bootstrap-target');
      mkdirSync(target, { recursive: true });

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('created');
      expect(result.path).toBe(join(target, '.archon', 'config.yaml'));
      expect(existsSync(result.path)).toBe(true);
      const content = readFileSync(result.path, 'utf-8');
      // Must be valid YAML — comment lines only — so loaders treat it as empty.
      expect(content.split('\n').every(line => line === '' || line.startsWith('#'))).toBe(true);
      expect(content).toContain('Project-scoped Archon config');
      expect(content).toContain('archon.diy/reference/configuration');
    });

    it('creates the .archon directory if missing (idempotent on parent)', () => {
      const target = join(TEST_DIR, 'bootstrap-no-archon-dir');
      mkdirSync(target, { recursive: true });
      // Do NOT pre-create .archon — bootstrap must create it

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('created');
      expect(existsSync(join(target, '.archon'))).toBe(true);
    });

    it('is idempotent — leaves an existing config untouched', () => {
      const target = join(TEST_DIR, 'bootstrap-existing');
      const archonDir = join(target, '.archon');
      mkdirSync(archonDir, { recursive: true });
      const userContent = '# my custom config\nassistants:\n  claude:\n    model: opus\n';
      writeFileSync(join(archonDir, 'config.yaml'), userContent);

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('existed');
      const after = readFileSync(join(archonDir, 'config.yaml'), 'utf-8');
      expect(after).toBe(userContent);
    });

    it('returns failed state without throwing when the target path is unwritable', () => {
      // Pointing at a path inside a non-existent parent that mkdirSync can
      // create succeeds. Use a deeply-nested path inside a regular file
      // (which fs cannot mkdir into) to force a real failure.
      const blocker = join(TEST_DIR, 'blocker-file');
      writeFileSync(blocker, 'not a directory');
      // mkdir under a file path fails with ENOTDIR — that's the failure mode
      // we want to model (read-only FS, permission denied, etc.).
      const result = bootstrapProjectConfig(blocker);

      expect(result.state).toBe('failed');
      if (result.state === 'failed') {
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('detectClaudeExecutablePath probe order', () => {
  // Use spies on the exported probe wrappers so each tier can be controlled
  // independently without touching the real filesystem or shell.
  let fileExistsSpy: ReturnType<typeof spyOn>;
  let npmRootSpy: ReturnType<typeof spyOn>;
  let whichSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fileExistsSpy = spyOn(setupModule, 'probeFileExists').mockReturnValue(false);
    npmRootSpy = spyOn(setupModule, 'probeNpmRoot').mockReturnValue(null);
    whichSpy = spyOn(setupModule, 'probeWhichClaude').mockReturnValue(null);
  });

  afterEach(() => {
    fileExistsSpy.mockRestore();
    npmRootSpy.mockRestore();
    whichSpy.mockRestore();
  });

  it('returns the native installer path when present (tier 1 wins)', () => {
    // Native path exists; subsequent probes must not be called.
    fileExistsSpy.mockImplementation(
      (p: string) => p.includes('.local/bin/claude') || p.includes('.local\\bin\\claude')
    );
    const result = detectClaudeExecutablePath();
    expect(result).toBeTruthy();
    expect(result).toMatch(/\.local[\\/]bin[\\/]claude/);
    // Tier 2 / 3 must not have been consulted.
    expect(npmRootSpy).not.toHaveBeenCalled();
    expect(whichSpy).not.toHaveBeenCalled();
  });

  it('falls through to npm cli.js when native is missing (tier 2 wins)', () => {
    // Use path.join so the expected result matches whatever separator the
    // production code produces on the current platform (backslash on Windows,
    // forward slash elsewhere).
    const npmRoot = join('fake', 'npm', 'root');
    const expectedCliJs = join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    npmRootSpy.mockReturnValue(npmRoot);
    fileExistsSpy.mockImplementation((p: string) => p === expectedCliJs);
    const result = detectClaudeExecutablePath();
    expect(result).toBe(expectedCliJs);
    // Tier 3 must not have been consulted.
    expect(whichSpy).not.toHaveBeenCalled();
  });

  it('falls through to which/where when native and npm probes both miss (tier 3 wins)', () => {
    npmRootSpy.mockReturnValue('/fake/npm/root');
    // Native miss, npm cli.js miss, but `which claude` returns a path that exists.
    whichSpy.mockReturnValue('/opt/homebrew/bin/claude');
    fileExistsSpy.mockImplementation((p: string) => p === '/opt/homebrew/bin/claude');
    const result = detectClaudeExecutablePath();
    expect(result).toBe('/opt/homebrew/bin/claude');
  });

  it('returns null when every probe misses', () => {
    // All defaults already return false/null; nothing to override.
    expect(detectClaudeExecutablePath()).toBeNull();
  });

  it('does not return a which-resolved path that fails the existsSync check', () => {
    // `which` returns a path string but the file is not actually present
    // (stale PATH entry, dangling symlink, etc.) — must not be returned.
    npmRootSpy.mockReturnValue('/fake/npm/root');
    whichSpy.mockReturnValue('/stale/path/claude');
    fileExistsSpy.mockReturnValue(false);
    expect(detectClaudeExecutablePath()).toBeNull();
  });

  it('skips npm tier when probeNpmRoot returns null (e.g. npm not installed)', () => {
    // npm probe fails; tier 3 must still run.
    whichSpy.mockReturnValue('/usr/local/bin/claude');
    fileExistsSpy.mockImplementation((p: string) => p === '/usr/local/bin/claude');
    const result = detectClaudeExecutablePath();
    expect(result).toBe('/usr/local/bin/claude');
    expect(npmRootSpy).toHaveBeenCalled();
  });
});

/**
 * Tests for the three-path env write model (#1303).
 *
 * Invariants:
 *   - <repo>/.env is NEVER written.
 *   - Default write targets ~/.archon/.env (home scope) with merge preserving
 *     existing non-empty values.
 *   - --scope project writes to <repo>/.archon/.env.
 *   - --force overwrites the target wholesale, still writes a backup.
 *   - Merge preserves user-added keys not in the proposed content.
 */
describe('writeScopedEnv (#1303)', () => {
  const ROOT = join(tmpdir(), 'archon-write-scoped-env-test-' + Date.now());
  const HOME_DIR = join(ROOT, 'archon-home');
  const REPO_DIR = join(ROOT, 'repo');
  let originalArchonHome: string | undefined;

  beforeEach(() => {
    mkdirSync(HOME_DIR, { recursive: true });
    mkdirSync(REPO_DIR, { recursive: true });
    originalArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = HOME_DIR;
  });

  afterEach(() => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('fresh home scope writes content with no backup', () => {
    const result = writeScopedEnv('DATABASE_URL=sqlite:local\nPORT=3090\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    expect(result.targetPath).toBe(join(HOME_DIR, '.env'));
    expect(result.backupPath).toBeNull();
    expect(result.preservedKeys).toEqual([]);
    expect(readFileSync(result.targetPath, 'utf-8')).toContain('DATABASE_URL=sqlite:local');
  });

  it('merge preserves user-added custom keys across re-runs', () => {
    // First write
    writeScopedEnv('DATABASE_URL=sqlite:local\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    // User adds a custom var
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, readFileSync(envPath, 'utf-8') + 'MY_CUSTOM_SECRET=preserve-me\n');
    // Second setup run (proposes a different-shape config)
    const result = writeScopedEnv('DATABASE_URL=sqlite:local\nPORT=3090\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    const merged = parseDotenv(readFileSync(result.targetPath, 'utf-8'));
    expect(merged.MY_CUSTOM_SECRET).toBe('preserve-me');
    expect(merged.PORT).toBe('3090');
    expect(result.backupPath).not.toBeNull();
  });

  it('a re-run moves an old Archon Codex setup to the new names and drops the old lines (#3562)', () => {
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(
      envPath,
      'CODEX_ID_TOKEN=old-id\nCODEX_ACCESS_TOKEN=old-access\nCODEX_REFRESH_TOKEN=old-rt\nCODEX_ACCOUNT_ID=old-acct\n'
    );
    // A re-run that does not touch Codex still migrates it; one that enters new
    // tokens leaves no stale CODEX_ACCESS_TOKEN behind for Codex to read.
    const result = writeScopedEnv('DATABASE_URL=sqlite:local\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    const merged = parseDotenv(readFileSync(result.targetPath, 'utf-8'));
    expect(merged).toMatchObject({
      ARCHON_CODEX_ID_TOKEN: 'old-id',
      ARCHON_CODEX_ACCESS_TOKEN: 'old-access',
      ARCHON_CODEX_REFRESH_TOKEN: 'old-rt',
      ARCHON_CODEX_ACCOUNT_ID: 'old-acct',
    });
    expect(Object.keys(merged).filter(key => key.startsWith('CODEX_'))).toEqual([]);
  });

  it('a re-run leaves a lone CODEX_ACCESS_TOKEN alone: it is the user’s Codex auth (#3562)', () => {
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, 'CODEX_ACCESS_TOKEN=users-own\n');
    const result = writeScopedEnv('DATABASE_URL=sqlite:local\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    const merged = parseDotenv(readFileSync(result.targetPath, 'utf-8'));
    expect(merged.CODEX_ACCESS_TOKEN).toBe('users-own');
    expect(merged.ARCHON_CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it('merge preserves existing PostgreSQL DATABASE_URL when proposed is SQLite', () => {
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, 'DATABASE_URL=postgresql://localhost:5432/mydb\n');
    const result = writeScopedEnv(
      '# Using SQLite (default) - no DATABASE_URL needed\nDATABASE_URL=\n',
      { scope: 'home', repoPath: REPO_DIR, force: false }
    );
    const merged = parseDotenv(readFileSync(result.targetPath, 'utf-8'));
    expect(merged.DATABASE_URL).toBe('postgresql://localhost:5432/mydb');
    expect(result.preservedKeys).toContain('DATABASE_URL');
  });

  it('merge preserves existing bot tokens', () => {
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(
      envPath,
      'SLACK_BOT_TOKEN=xoxb-existing\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-existing\n'
    );
    // Proposed content has these keys with different/empty values
    writeScopedEnv('SLACK_BOT_TOKEN=xoxb-new-placeholder\nCLAUDE_CODE_OAUTH_TOKEN=\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    const merged = parseDotenv(readFileSync(join(HOME_DIR, '.env'), 'utf-8'));
    expect(merged.SLACK_BOT_TOKEN).toBe('xoxb-existing');
    expect(merged.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-existing');
  });

  it('--force overwrites wholesale but writes a timestamped backup', () => {
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, 'OLD_KEY=old\nDATABASE_URL=postgresql://legacy\n');
    const result = writeScopedEnv('DATABASE_URL=sqlite:local\nNEW_KEY=new\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: true,
    });
    expect(result.forced).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath).toMatch(/\.archon-backup-\d{4}-\d{2}-\d{2}T/);
    // Backup has the old content
    expect(readFileSync(result.backupPath as string, 'utf-8')).toContain('OLD_KEY=old');
    // Target has the new content only — OLD_KEY is gone
    const newContent = readFileSync(result.targetPath, 'utf-8');
    expect(newContent).toContain('DATABASE_URL=sqlite:local');
    expect(newContent).toContain('NEW_KEY=new');
    expect(newContent).not.toContain('OLD_KEY');
  });

  it('--force on a non-existent target writes cleanly with no backup', () => {
    const result = writeScopedEnv('PORT=3090\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: true,
    });
    expect(result.backupPath).toBeNull();
    expect(result.forced).toBe(false); // no existing file means force was effectively a no-op
  });

  it('--scope project writes to <repo>/.archon/.env, creating the directory', () => {
    expect(existsSync(join(REPO_DIR, '.archon'))).toBe(false);
    const result = writeScopedEnv('FOO=bar\n', {
      scope: 'project',
      repoPath: REPO_DIR,
      force: false,
    });
    expect(result.targetPath).toBe(join(REPO_DIR, '.archon', '.env'));
    expect(existsSync(result.targetPath)).toBe(true);
    expect(existsSync(join(HOME_DIR, '.env'))).toBe(false);
  });

  it('<repo>/.env is never touched by writeScopedEnv in any scope/mode', () => {
    const repoEnvPath = join(REPO_DIR, '.env');
    const sentinel = 'USER_SECRET=do-not-touch\n';
    writeFileSync(repoEnvPath, sentinel);
    // Home scope, merge
    writeScopedEnv('FOO=bar\n', { scope: 'home', repoPath: REPO_DIR, force: false });
    // Home scope, force
    writeScopedEnv('FOO=baz\n', { scope: 'home', repoPath: REPO_DIR, force: true });
    // Project scope, merge
    writeScopedEnv('FOO=qux\n', { scope: 'project', repoPath: REPO_DIR, force: false });
    // Project scope, force
    writeScopedEnv('FOO=xyz\n', { scope: 'project', repoPath: REPO_DIR, force: true });
    expect(readFileSync(repoEnvPath, 'utf-8')).toBe(sentinel);
  });

  it('resolveScopedEnvPath returns the archon-owned path for each scope', () => {
    expect(resolveScopedEnvPath('home', REPO_DIR)).toBe(join(HOME_DIR, '.env'));
    expect(resolveScopedEnvPath('project', REPO_DIR)).toBe(join(REPO_DIR, '.archon', '.env'));
  });

  it('serializeEnv round-trips through dotenv.parse', () => {
    const entries = {
      SIMPLE: 'value',
      WITH_SPACE: 'hello world',
      WITH_HASH: 'value#not-a-comment',
      EMPTY: '',
    };
    const serialized = serializeEnv(entries);
    const parsed = parseDotenv(serialized);
    expect(parsed.SIMPLE).toBe('value');
    expect(parsed.WITH_SPACE).toBe('hello world');
    expect(parsed.WITH_HASH).toBe('value#not-a-comment');
    expect(parsed.EMPTY).toBe('');
  });

  it('serializeEnv preserves private-key paths and secrets with backslashes or quotes', () => {
    const entries = {
      GITHUB_APP_PRIVATE_KEY_PATH: String.raw`C:\new folder\app.pem`,
      WEBHOOK_SECRET: 'secret"with#quotes',
      CUSTOM_KEY: `value'with"both#quotes`,
      LITERAL_NEWLINE: String.raw`literal \n`,
      TRAILING_BACKSLASH: 'C:\\folder#name\\',
      ESCAPED_QUOTE: String.raw`has \" and ' and ${'`'} # hash`,
    };
    expect(parseDotenv(serializeEnv(entries))).toEqual(entries);
  });

  it('merge preserves a bare custom value containing every quote delimiter', () => {
    const value = '\"single\'back`tick';
    const original = `CUSTOM_KEY=${value}\n`;
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, original);
    expect(parseDotenv(original).CUSTOM_KEY).toBe(value);
    writeScopedEnv('NEW_KEY=new\n', { scope: 'home', repoPath: REPO_DIR, force: false });
    expect(parseDotenv(readFileSync(envPath, 'utf8'))).toEqual({
      CUSTOM_KEY: value,
      NEW_KEY: 'new',
    });
  });

  it.each(["'", '"', '`'])('merge preserves adjacent values that start and end with %s', quote => {
    const wrapper = quote === "'" ? '"' : "'";
    const original = `FIRST=${wrapper}${quote}start${wrapper}\nSECOND=${wrapper}end${quote}${wrapper}\n`;
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, original);
    const result = writeScopedEnv('NEW_KEY=new\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    expect(parseDotenv(readFileSync(result.targetPath, 'utf8'))).toEqual({
      ...parseDotenv(original),
      NEW_KEY: 'new',
    });
  });

  it.each(["'", '"', '`'])('merge preserves a trailing backslash quoted with %s', quote => {
    const original = `CUSTOM_PATH=${quote}C:\\folder#name\\${quote}\n`;
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, original);
    writeScopedEnv('NEW_KEY=new\n', { scope: 'home', repoPath: REPO_DIR, force: false });
    expect(parseDotenv(readFileSync(envPath, 'utf8'))).toEqual({
      ...parseDotenv(original),
      NEW_KEY: 'new',
    });
  });

  it('serializeEnv escapes \\r so bare CRs survive round-trip', () => {
    const entries = { WITH_CR: 'line1\rline2', WITH_CRLF: 'a\r\nb' };
    const serialized = serializeEnv(entries);
    const parsed = parseDotenv(serialized);
    expect(parsed.WITH_CR).toBe('line1\rline2');
    expect(parsed.WITH_CRLF).toBe('a\r\nb');
  });

  it('merge treats whitespace-only existing values as empty (replaces them)', () => {
    const envPath = join(HOME_DIR, '.env');
    writeFileSync(envPath, 'API_KEY=   \nNORMAL=keep-me\n');
    const result = writeScopedEnv('API_KEY=real-token\nNORMAL=from-wizard\n', {
      scope: 'home',
      repoPath: REPO_DIR,
      force: false,
    });
    const merged = parseDotenv(readFileSync(result.targetPath, 'utf-8'));
    // Whitespace-only API_KEY was replaced by the proposed value.
    expect(merged.API_KEY).toBe('real-token');
    // Non-empty NORMAL was preserved and reported.
    expect(merged.NORMAL).toBe('keep-me');
    expect(result.preservedKeys).toContain('NORMAL');
    expect(result.preservedKeys).not.toContain('API_KEY');
  });
});

describe('writeHomePiModelConfig', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archon-pi-config-'));
    originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalHome !== undefined) {
      process.env.ARCHON_HOME = originalHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
  });

  it('writes fresh assistants.pi.model block when config is empty', () => {
    writeHomePiModelConfig('anthropic/claude-haiku-4-5');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('assistants:');
    expect(content).toContain('pi:');
    expect(content).toContain('model: "anthropic/claude-haiku-4-5"');
  });

  it('writes fresh block when config does not exist yet', () => {
    // No config.yaml pre-created — function must create it.
    writeHomePiModelConfig('openai/gpt-4o');
    expect(existsSync(join(tmpDir, 'config.yaml'))).toBe(true);
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('pi:');
    expect(content).toContain('model: "openai/gpt-4o"');
  });

  it('skips write when existing config already contains pi: (idempotent)', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), 'assistants:\n  pi:\n    model: "old"\n');
    writeHomePiModelConfig('anthropic/claude-haiku-4-5');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('model: "old"');
    expect(content).not.toContain('claude-haiku-4-5');
  });

  it('does not write pi: block when config has assistants: but no pi: (shows note instead)', () => {
    writeFileSync(join(tmpDir, 'config.yaml'), 'assistants:\n  claude:\n    model: sonnet\n');
    writeHomePiModelConfig('openai/gpt-4o');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    // Should NOT have injected a pi: key — only a note() was shown.
    expect(content).not.toContain('pi:');
  });

  it('escapes double quotes in the model name', () => {
    writeHomePiModelConfig('vendor/"weird-model"');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('\\"weird-model\\"');
  });

  it('does not false-positive on api: substring (regex guard for includes bug)', () => {
    // A config with `api:` but no `pi:` should fall through to the append branch,
    // not the idempotent-skip branch.
    writeFileSync(join(tmpDir, 'config.yaml'), '# config\napi:\n  key: abc\n');
    writeHomePiModelConfig('openai/gpt-4o');
    const content = readFileSync(join(tmpDir, 'config.yaml'), 'utf-8');
    expect(content).toContain('pi:');
  });
});

describe('buildDefaultModelChoices (#1999)', () => {
  it('leads with "Keep SDK default" when no current model and ends with the free-text escape', () => {
    const choices = buildDefaultModelChoices('claude', undefined);
    expect(choices[0].value).toBe('__keep__');
    expect(choices[0].label).toBe('Keep SDK default');
    expect(choices[choices.length - 1].value).toBe('__custom__');
  });

  it('surfaces the current model in the keep option label on re-run', () => {
    const choices = buildDefaultModelChoices('claude', 'opus');
    expect(choices[0].label).toBe('Keep current (opus)');
  });

  it('includes the curated claude shortlist between keep and custom', () => {
    const values = buildDefaultModelChoices('claude', undefined).map(c => c.value);
    expect(values).toEqual(['__keep__', 'sonnet', 'opus', 'haiku', '__custom__']);
  });

  it('includes the curated codex shortlist', () => {
    const values = buildDefaultModelChoices('codex', undefined).map(c => c.value);
    expect(values).toEqual([
      '__keep__',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      '__custom__',
    ]);
  });

  it('falls back to keep + custom only for providers without a curated list', () => {
    const values = buildDefaultModelChoices('some-future-provider', undefined).map(c => c.value);
    expect(values).toEqual(['__keep__', '__custom__']);
  });
});

describe('writeInstallDefaults (#1999)', () => {
  const baseAi = {
    claude: true,
    codex: false,
    pi: false,
    defaultAssistant: 'claude',
  };

  it('writes provider + model together when a chat model was chosen', async () => {
    const calls: [string, string | undefined][] = [];
    const written = await writeInstallDefaults(
      { ...baseAi, defaultAssistantSelected: true, defaultModel: 'opus' },
      async (provider, model) => {
        calls.push([provider, model]);
      }
    );
    expect(written).toBe(true);
    expect(calls).toEqual([['claude', 'opus']]);
  });

  it('writes defaultAssistant alone when the model was skipped (stale-config guard)', async () => {
    // The .env DEFAULT_AI_ASSISTANT is fallback-only, so skipping the model
    // must still record the wizard's fresh selection in config.yaml.
    const calls: [string, string | undefined][] = [];
    const written = await writeInstallDefaults(
      { ...baseAi, defaultAssistantSelected: true },
      async (provider, model) => {
        calls.push([provider, model]);
      }
    );
    expect(written).toBe(true);
    expect(calls).toEqual([['claude', undefined]]);
  });

  it('does not write when the default was a registry fallback, not a selection', async () => {
    // 'add' mode and the no-assistant early return leave
    // defaultAssistantSelected unset — the fallback value must never clobber
    // an existing config.yaml defaultAssistant.
    const calls: unknown[] = [];
    const written = await writeInstallDefaults({ ...baseAi }, async (...args) => {
      calls.push(args);
    });
    expect(written).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is non-fatal when the write fails (env write already succeeded)', async () => {
    const written = await writeInstallDefaults(
      { ...baseAi, defaultAssistantSelected: true, defaultModel: 'opus' },
      async () => {
        throw Object.assign(new Error('read-only fs'), { code: 'EROFS' });
      }
    );
    expect(written).toBe(false);
  });
});

describe('readInstallDefaultModel (#1999)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archon-default-model-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const configAt = (content: string): string => {
    const path = join(tmpDir, 'config.yaml');
    writeFileSync(path, content);
    return path;
  };

  it('returns the configured model from assistants.<provider>.model', () => {
    const path = configAt(
      'assistants:\n  claude:\n    model: opus\n  codex:\n    model: gpt-5.5\n'
    );
    expect(readInstallDefaultModel('claude', path)).toBe('opus');
    expect(readInstallDefaultModel('codex', path)).toBe('gpt-5.5');
  });

  it('returns undefined when the config file does not exist', () => {
    expect(readInstallDefaultModel('claude', join(tmpDir, 'missing.yaml'))).toBeUndefined();
  });

  it('returns undefined when the provider has no model entry', () => {
    const path = configAt('assistants:\n  claude:\n    settingSources:\n      - project\n');
    expect(readInstallDefaultModel('claude', path)).toBeUndefined();
    expect(readInstallDefaultModel('codex', path)).toBeUndefined();
  });

  it('treats inherit / empty / non-string models as unset', () => {
    expect(
      readInstallDefaultModel('claude', configAt('assistants:\n  claude:\n    model: inherit\n'))
    ).toBeUndefined();
    expect(
      readInstallDefaultModel('claude', configAt('assistants:\n  claude:\n    model: ""\n'))
    ).toBeUndefined();
    expect(
      readInstallDefaultModel('claude', configAt('assistants:\n  claude:\n    model: 42\n'))
    ).toBeUndefined();
  });

  it('returns undefined (not a throw) on malformed YAML', () => {
    // Best-effort hint read: a hand-edited broken config must not break setup.
    expect(readInstallDefaultModel('claude', configAt(':: not yaml ::\n\t{ nope'))).toBeUndefined();
  });
});

describe('setup provider selection', () => {
  it('an explicit selection installs without asking', async () => {
    const install = mock(async (_ids: readonly string[]) => undefined);
    const ask = mock(async () => ['claude']);
    expect(await selectSetupProviders(['codex'], install, ask)).toEqual(['codex']);
    expect(install).toHaveBeenCalledWith(['codex']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('the maintained-provider multiselect drives installation', async () => {
    const prompt = spyOn(prompts, 'multiselect').mockResolvedValue(['codex', 'pi']);
    const install = mock(async (_ids: readonly string[]) => undefined);
    try {
      expect(await selectSetupProviders(undefined, install)).toEqual(['codex', 'pi']);
      expect(install).toHaveBeenCalledWith(['codex', 'pi']);
      expect(prompt.mock.calls[0][0].options.map(option => option.value)).toEqual([
        'claude',
        'codex',
        'pi',
      ]);
    } finally {
      prompt.mockRestore();
    }
  });

  it('an empty selection installs nothing and prints the install command', async () => {
    const install = mock(async (_ids: readonly string[]) => undefined);
    const warning = spyOn(prompts.log, 'warning').mockImplementation(() => undefined);
    try {
      expect(await selectSetupProviders([], install)).toEqual([]);
      expect(install).not.toHaveBeenCalled();
      expect(warning.mock.calls.flat().join('')).toContain('archon provider add');
    } finally {
      warning.mockRestore();
    }
  });

  it('validates the whole selection before installing and propagates install failure', async () => {
    const install = mock(async (_ids: readonly string[]) => {
      throw new Error('download failed');
    });
    await expect(selectSetupProviders(['codex', 'unknown'], install)).rejects.toThrow(
      'Unknown maintained provider'
    );
    expect(install).not.toHaveBeenCalled();
    await expect(selectSetupProviders(['codex'], install)).rejects.toThrow('download failed');
  });

  it.each(['fresh', 'add'] as const)(
    '%s setup uses diagnostics and persists the selected default for multiple providers',
    async mode => {
      const root = mkdtempSync(join(tmpdir(), 'archon-setup-providers-'));
      const saved = {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        ARCHON_HOME: process.env.ARCHON_HOME,
      };
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      process.env.ARCHON_HOME = join(root, 'archon');
      if (mode === 'add') {
        mkdirSync(join(root, 'archon'));
        writeFileSync(join(root, 'archon', '.env'), 'SLACK_BOT_TOKEN=preserved\n');
      }
      const selection = spyOn(prompts, 'select').mockImplementation(async options => {
        const wanted =
          options.message === 'What would you like to do?'
            ? 'add'
            : options.message.startsWith('How do you want')
              ? 'global'
              : options.message.startsWith('Which should')
                ? 'codex'
                : '__keep__';
        const chosen = options.options.find(option => option.value === wanted);
        if (!chosen) throw new Error(`Unexpected prompt: ${options.message}`);
        return chosen.value;
      });
      const input = spyOn(prompts, 'text').mockResolvedValue('');
      const confirm = spyOn(prompts, 'confirm').mockResolvedValue(false);
      const detect = spyOn(setupModule, 'detectClaudeExecutablePath').mockReturnValue(null);
      const info = spyOn(prompts.log, 'info').mockImplementation(() => undefined);
      const install = mock(async (_ids: readonly string[]) => undefined);
      const diagnose = mock(async (id: string) => [
        { label: id, status: 'pass' as const, message: 'provider-owned check' },
      ]);
      const originalCollect = collectAIConfig;
      const collect = spyOn(setupModule, 'collectAIConfig').mockImplementation(options =>
        originalCollect(options, install, diagnose)
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      const doctor = spyOn(doctorModule, 'doctorCommand').mockResolvedValue(0);
      try {
        expect(await setupCommand({ repoPath: root, providers: ['claude', 'codex'] })).toBe(0);
        expect(install).toHaveBeenCalledWith(['claude', 'codex']);
        expect(diagnose.mock.calls).toEqual([['claude'], ['codex']]);
        expect(info.mock.calls.flat().join('')).toContain('provider-owned check');
        const written = Bun.YAML.parse(readFileSync(join(root, 'archon', 'config.yaml'), 'utf8'));
        expect(written).toMatchObject({ defaultAssistant: 'codex' });
        if (mode === 'add') {
          expect(readFileSync(join(root, 'archon', '.env'), 'utf8')).toContain(
            'SLACK_BOT_TOKEN=preserved'
          );
        }
      } finally {
        for (const spy of [selection, input, confirm, detect, info, collect, platforms, doctor])
          spy.mockRestore();
        for (const key of ['HOME', 'USERPROFILE', 'ARCHON_HOME'] as const) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
        await removeTempTree(root);
      }
    }
  );
});

describe('GitHub setup wizard', () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const pat = 'ghp_fixture_token';
  let appId: string;
  let appSlug: string;
  let inputValidation: (string | Error | undefined)[];
  let webhookSecret: string;
  let botDisplayName: string;
  let keyPem: string;
  let keyValidation: (string | Error | undefined)[];
  let root: string;
  let target: string;
  let keyPath: string;
  let allowedUsers: string | symbol;
  let savedHome: string | undefined;
  let authMode: 'app' | 'pat';
  let keySource: 'path' | 'inline';
  let switchAnswer: boolean | symbol;
  let setupMode: 'update' | 'add' | 'fresh';
  let scope: 'home' | 'project';
  let output: string[];
  let restore: (() => void)[];
  let initialAuthMode: unknown;
  const cancelled = Symbol('cancelled');
  const nativeIsCancel = prompts.isCancel;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'archon-setup-github-'));
    savedHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, '.archon'));
    target = join(root, '.archon', '.env');
    appId = '123';
    appSlug = 'fixture-app';
    inputValidation = [];
    webhookSecret = 'fixture-webhook-secret';
    botDisplayName = 'Archon';
    keyPem = privateKey;
    keyValidation = [];
    allowedUsers = '';
    keyPath = join(root, 'app.pem');
    writeFileSync(keyPath, privateKey);
    authMode = 'app';
    keySource = 'path';
    switchAnswer = true;
    setupMode = 'update';
    scope = 'project';
    output = [];
    initialAuthMode = undefined;
    const cancellation = spyOn(prompts, 'isCancel').mockImplementation(
      (value): value is symbol => value === cancelled || nativeIsCancel(value)
    );
    const selection = spyOn(prompts, 'select').mockImplementation(async options => {
      if (options.message === 'GitHub authentication mode?') initialAuthMode = options.initialValue;
      const wanted =
        options.message === 'What would you like to do?'
          ? setupMode
          : options.message === 'GitHub authentication mode?'
            ? authMode
            : options.message === 'GitHub App private key source?'
              ? keySource
              : undefined;
      const chosen = options.options.find(option => option.value === wanted);
      if (!chosen) throw new Error(`Unexpected select: ${options.message}`);
      return chosen.value;
    });
    const input = spyOn(prompts, 'text').mockImplementation(async options => {
      if (options.message === 'Enter allowed Telegram user IDs (comma-separated):') return '222';
      if (
        options.message ===
        'Enter allowed Slack user IDs (comma-separated, or leave empty for all):'
      )
        return 'U222';
      if (options.message === 'Enter the bot display name:') return botDisplayName;
      if (options.message === 'GitHub App ID:') {
        const error = await options.validate?.(appId);
        inputValidation.push(error);
        return error ? cancelled : appId;
      }
      if (
        options.message ===
        'Enter allowed GitHub usernames (comma-separated, or leave empty for all):'
      )
        return allowedUsers;
      if (options.message === 'GitHub App private key path:') {
        const error = await options.validate?.(keyPath);
        keyValidation.push(error);
        return error ? cancelled : keyPath;
      }
      if (options.message === 'GitHub App slug (optional):') return appSlug;
      return '';
    });
    const secret = spyOn(prompts, 'password').mockImplementation(async options => {
      if (options.message === 'Enter your Telegram Bot Token:') return '123456:new-telegram';
      if (options.message === 'Enter your Slack Bot Token (xoxb-...):') return 'xoxb-new-slack';
      if (options.message === 'Enter your Slack App Token (xapp-...):') return 'xapp-new-slack';
      if (options.message === 'GitHub App private key (PEM):') {
        const value = keyPem.replace(/\n/g, '\\n');
        const error = await options.validate?.(value);
        keyValidation.push(error);
        return error ? cancelled : value;
      }
      if (options.message === 'GitHub webhook secret:') {
        const error = await options.validate?.(webhookSecret);
        inputValidation.push(error);
        return error ? cancelled : webhookSecret;
      }
      if (options.message === 'Enter your GitHub Personal Access Token:') return pat;
      throw new Error(`Unexpected password: ${options.message}`);
    });
    const confirmation = spyOn(prompts, 'confirm').mockImplementation(async options =>
      options.message.startsWith('Replace existing GitHub authentication')
        ? switchAnswer
        : options.message === 'Do you want to set a custom bot display name? (Default: Archon)' &&
          botDisplayName !== 'Archon'
    );
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue(['github']);
    const notes = spyOn(prompts, 'note').mockImplementation(message => {
      output.push(message ?? '');
    });
    const info = spyOn(prompts.log, 'info').mockImplementation(message => {
      output.push(message);
    });
    const success = spyOn(prompts.log, 'success').mockImplementation(message => {
      output.push(message);
    });
    const cancellationOutput = spyOn(prompts, 'cancel').mockImplementation(message => {
      output.push(message ?? '');
    });
    const gh = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
    restore = [
      cancellation,
      cancellationOutput,
      selection,
      input,
      secret,
      confirmation,
      platforms,
      notes,
      info,
      success,
      gh,
    ].map(spy => () => spy.mockRestore());
  });

  afterEach(async () => {
    for (const undo of restore) undo();
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
    await removeTempTree(root);
  });

  const run = (force = false) => setupCommand({ repoPath: root, scope, providers: [], force });
  const read = () => parseDotenv(readFileSync(target, 'utf8'));

  it.each([
    ['home', 'app', true],
    ['home', 'pat', true],
    ['project', 'app', true],
    ['project', 'pat', true],
    ['home', 'app', false],
    ['home', 'pat', false],
    ['project', 'app', false],
    ['project', 'pat', false],
  ] as const)(
    'Add in %s with %s and force=%j keeps every reported platform authenticated',
    async (selectedScope, selectedMode, force) => {
      scope = selectedScope;
      target = resolveScopedEnvPath(scope, root);
      setupMode = 'add';
      authMode = selectedMode;
      const original = serializeEnv({
        ...(authMode === 'app'
          ? { GITHUB_APP_ID: '999', GITHUB_APP_PRIVATE_KEY_PATH: keyPath }
          : { GITHUB_TOKEN: 'old-token' }),
        WEBHOOK_SECRET: 'old-webhook',
        TELEGRAM_BOT_TOKEN: '123456:old-telegram',
        TELEGRAM_ALLOWED_USER_IDS: '111',
        SLACK_BOT_TOKEN: 'xoxb-old-slack',
        SLACK_APP_TOKEN: 'xapp-old-slack',
        SLACK_ALLOWED_USER_IDS: 'U111',
        CUSTOM_KEY: 'keep',
      });
      writeFileSync(target, original);
      expect(checkExistingConfig(target)?.platforms).toEqual({
        github: true,
        telegram: true,
        slack: true,
      });
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await run(force)).toBe(0);
        const env = read();
        expect(selectGitHubAuthMode(env)).toEqual({ kind: selectedMode });
        if (selectedMode === 'app') {
          expect(loadGitHubAppConfig(env)).toMatchObject({
            appId: force ? '123' : '999',
            privateKey,
          });
          expect(env.GITHUB_TOKEN).toBeUndefined();
          expect(env.GH_TOKEN).toBeUndefined();
        } else {
          expect(env.GITHUB_TOKEN).toBe(force ? pat : 'old-token');
        }
        expect(env.WEBHOOK_SECRET).toBeTruthy();
        expect(env.TELEGRAM_BOT_TOKEN).toBe(force ? '123456:new-telegram' : '123456:old-telegram');
        expect(env.TELEGRAM_ALLOWED_USER_IDS).toBe(force ? '222' : '111');
        expect(env.SLACK_BOT_TOKEN).toBe(force ? 'xoxb-new-slack' : 'xoxb-old-slack');
        expect(env.SLACK_APP_TOKEN).toBe(force ? 'xapp-new-slack' : 'xapp-old-slack');
        expect(env.SLACK_ALLOWED_USER_IDS).toBe(force ? 'U222' : 'U111');
        if (force) expect(env.CUSTOM_KEY).toBeUndefined();
        else expect(env.CUSTOM_KEY).toBe('keep');
        expect(output.find(message => message.startsWith('AI:'))).toContain(
          'Platforms: GitHub, Telegram, Slack'
        );
        for (const value of [
          env.GITHUB_TOKEN,
          env.WEBHOOK_SECRET,
          env.TELEGRAM_BOT_TOKEN,
          env.SLACK_BOT_TOKEN,
          env.SLACK_APP_TOKEN,
          privateKey,
        ]) {
          if (value) expect(output.join('\n')).not.toContain(value);
        }
        const backups = Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(target)));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dirname(target), backups[0]), 'utf8')).toBe(original);
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it('switch cleanup covers every App env key read by runtime authentication', () => {
    const authDir = join(import.meta.dir, '../../../core/src/github-auth');
    const readKeys = new Set<string>();
    for (const file of new Bun.Glob('**/*.ts').scanSync(authDir)) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(authDir, file), 'utf8');
      for (const match of source.matchAll(/\benv\.(GITHUB_APP_[A-Z_]+)\b/g)) readKeys.add(match[1]);
    }
    expect([...readKeys].sort()).toEqual([...GITHUB_APP_KEYS].sort());
  });

  it.each(['0', '-1', 'abc', '1.2', '   '])(
    'rejects invalid App ID %j before writing',
    async value => {
      appId = value;
      expect(await run()).toBe(0);
      expect(inputValidation).toEqual(['Enter a positive decimal App ID']);
      expect(existsSync(target)).toBe(false);
    }
  );

  it('rejects a whitespace webhook secret before writing', async () => {
    webhookSecret = '   ';
    expect(await run()).toBe(0);
    expect(inputValidation).toEqual([undefined, 'Enter the secret configured on your GitHub App']);
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    ['app', 'GH_TOKEN', ''],
    ['app', 'GITHUB_TOKEN', ''],
    ...GITHUB_APP_KEYS.map(key => ['pat', key, ''] as const),
    ['pat', 'GITHUB_APP_CLIENT_ID', 'Iv1.old'],
    ['pat', 'GITHUB_APP_SLUG', 'old-app'],
    ['pat', 'GITHUB_APP_INSTALLATION_ID', '999'],
  ] as const)('preserves %s credentials with inactive %s=%j', async (mode, key, value) => {
    authMode = mode;
    const original = serializeEnv({
      ...(mode === 'app'
        ? { GITHUB_APP_ID: '999', GITHUB_APP_PRIVATE_KEY_PATH: keyPath }
        : { GITHUB_TOKEN: 'old-token' }),
      [key]: value,
      WEBHOOK_SECRET: 'old-webhook',
      CUSTOM_KEY: 'keep',
    });
    writeFileSync(target, original);
    switchAnswer = false;
    expect(await run()).toBe(0);
    expect(output).not.toContain('Setup cancelled. Existing configuration was not changed.');
    const env = read();
    expect(selectGitHubAuthMode(env)).toEqual({ kind: mode });
    expect(env.WEBHOOK_SECRET).toBe('old-webhook');
    expect(env.CUSTOM_KEY).toBe('keep');
    if (mode === 'app') {
      expect(loadGitHubAppConfig(env)).toMatchObject({ appId: '999', privateKey });
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
    } else {
      expect(env.GITHUB_TOKEN).toBe('old-token');
      expect(loadGitHubAppConfig(env)).toBeNull();
    }
    const backups = Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(target)));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(target), backups[0]), 'utf8')).toBe(original);
  });

  it.each([...GITHUB_APP_CREDENTIAL_KEYS])(
    'rejects PAT beside partial %s in Add and workflow loading',
    async key => {
      setupMode = 'add';
      const env = { GITHUB_TOKEN: pat, WEBHOOK_SECRET: webhookSecret, [key]: 'partial' };
      expect(() => loadGitHubAppConfig(env)).toThrow('both App mode');
      const original = serializeEnv(env);
      writeFileSync(target, original);
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await run()).toBe(1);
        expect(readFileSync(target, 'utf8')).toBe(original);
        expect(Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(target)))).toEqual(
          []
        );
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(['path', 'inline'] as const)(
    'writes a fresh App using %s without PAT keys or secret output',
    async source => {
      keySource = source;
      expect(await run()).toBe(0);
      const env = read();
      expect(keyValidation).toEqual([undefined]);
      expect(inputValidation).toEqual([undefined, undefined]);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.WEBHOOK_SECRET).toBe(webhookSecret);
      expect(loadGitHubAppConfig(env)).toMatchObject({
        appId: '123',
        slug: 'fixture-app',
        privateKey,
      });
      const messages = output.join('\n');
      expect(messages).toContain('adapters/github-app-setup');
      expect(messages).not.toContain(webhookSecret);
      expect(messages).not.toContain(privateKey);
      expect(existsSync(join(root, 'home', '.env'))).toBe(false);
    }
  );

  it('loads fresh App configuration when the optional slug is unanswered', async () => {
    appSlug = '';
    expect(await run()).toBe(0);
    expect(loadGitHubAppConfig(read())?.slug).toBe('archon');
  });

  const blankAppCases = (['add', 'update', 'fresh'] as const).flatMap(mode =>
    [false, true].flatMap(force =>
      (['home', 'project'] as const).flatMap(selectedScope =>
        (['path', 'inline'] as const).flatMap(source =>
          ['', '   '].flatMap(blank =>
            (['selected', 'other'] as const).flatMap(placement => {
              const keys = ['GITHUB_APP_SLUG', 'GITHUB_APP_INSTALLATION_ID'];
              if (placement === 'other' && selectedScope === 'home') {
                keys.push(
                  'GITHUB_APP_ID',
                  source === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY'
                );
              }
              return keys.map(key => ({
                mode,
                force,
                selectedScope,
                source,
                blank,
                placement,
                key,
              }));
            })
          )
        )
      )
    )
  );

  it.each(blankAppCases)(
    'handles blank App overlay $key in $placement ($mode, $selectedScope, $source, force=$force, blank="$blank")',
    async scenario => {
      setupMode = scenario.mode;
      scope = scenario.selectedScope;
      keySource = scenario.source;
      appSlug = '';
      target = resolveScopedEnvPath(scope, root);
      const otherPath = resolveScopedEnvPath(scope === 'home' ? 'project' : 'home', root);
      const blankPath = scenario.placement === 'selected' ? target : otherPath;
      const original = serializeEnv({ [scenario.key]: scenario.blank, CUSTOM_KEY: 'keep' });
      writeFileSync(blankPath, original);
      const result = await run(scenario.force);
      const blocked = scenario.placement === 'other';
      expect(result).toBe(blocked ? 1 : 0);
      if (blocked) {
        expect(readFileSync(otherPath, 'utf8')).toBe(original);
        expect(existsSync(target)).toBe(false);
      } else {
        const homePath = resolveScopedEnvPath('home', root);
        const home = existsSync(homePath) ? parseDotenv(readFileSync(homePath, 'utf8')) : {};
        const projectPath = resolveScopedEnvPath('project', root);
        const project = existsSync(projectPath)
          ? parseDotenv(readFileSync(projectPath, 'utf8'))
          : {};
        expect(loadGitHubAppConfig({ ...home, ...project })).toMatchObject({
          appId: '123',
          privateKey,
          slug: 'archon',
        });
        if (!scenario.force) expect(read().CUSTOM_KEY).toBe('keep');
      }
    }
  );

  it.each(['GITHUB_APP_SLUG', 'GITHUB_APP_INSTALLATION_ID'])(
    'Add removes selected blank %s even when GitHub collection is skipped',
    async key => {
      setupMode = 'add';
      writeFileSync(
        target,
        serializeEnv({
          GITHUB_APP_ID: '123',
          GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
          WEBHOOK_SECRET: webhookSecret,
          [key]: '   ',
        })
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await run()).toBe(0);
        expect(loadGitHubAppConfig(read())).toMatchObject({
          appId: '123',
          slug: 'archon',
          privateKey,
        });
        expect(read()[key]).toBeUndefined();
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(['GITHUB_APP_SLUG', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH'])(
    'project App proposal safely overrides a home blank %s',
    async key => {
      writeFileSync(resolveScopedEnvPath('home', root), serializeEnv({ [key]: '   ' }));
      expect(await run()).toBe(0);
      const home = parseDotenv(readFileSync(resolveScopedEnvPath('home', root), 'utf8'));
      expect(loadGitHubAppConfig({ ...home, ...read() })).toMatchObject({
        appId: '123',
        slug: 'fixture-app',
        privateKey,
      });
    }
  );

  const retainedOverlayCases = (['update', 'fresh'] as const).flatMap(mode =>
    (['home', 'project'] as const).flatMap(selectedScope =>
      (['path', 'inline'] as const).flatMap(source =>
        ['GITHUB_APP_SLUG', 'GITHUB_APP_INSTALLATION_ID'].map(key => ({
          mode,
          selectedScope,
          source,
          key,
        }))
      )
    )
  );
  it.each(retainedOverlayCases)(
    'rejects retained App with other-scope blank $key ($mode, $selectedScope, $source)',
    async scenario => {
      setupMode = scenario.mode;
      scope = scenario.selectedScope;
      target = resolveScopedEnvPath(scope, root);
      const otherPath = resolveScopedEnvPath(scope === 'home' ? 'project' : 'home', root);
      const original = serializeEnv({
        GITHUB_APP_ID: '123',
        [scenario.source === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY']:
          scenario.source === 'path' ? keyPath : privateKey,
        WEBHOOK_SECRET: webhookSecret,
      });
      writeFileSync(target, original);
      writeFileSync(otherPath, serializeEnv({ [scenario.key]: '' }));
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await run()).toBe(1);
        expect(readFileSync(target, 'utf8')).toBe(original);
        expect(readdirSync(dirname(target))).toEqual(['.env']);
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(
    (['path', 'inline'] as const).flatMap(source =>
      ['', '   '].flatMap(blank =>
        (blank ? ['credentials'] : ['credentials', 'webhook']).map(disabled => ({
          source,
          blank,
          disabled,
        }))
      )
    )
  )(
    'rejects project overlay disabling proposed home App ($source, $disabled, "$blank")',
    async scenario => {
      scope = 'home';
      target = resolveScopedEnvPath(scope, root);
      keySource = scenario.source;
      const otherPath = resolveScopedEnvPath('project', root);
      const original = serializeEnv(
        scenario.disabled === 'webhook'
          ? { WEBHOOK_SECRET: scenario.blank }
          : {
              GITHUB_APP_ID: scenario.blank,
              GITHUB_APP_PRIVATE_KEY: scenario.blank,
              GITHUB_APP_PRIVATE_KEY_PATH: scenario.blank,
            }
      );
      writeFileSync(otherPath, original);
      expect(await run()).toBe(1);
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(otherPath, 'utf8')).toBe(original);
    }
  );

  it('rejects a retained home App disabled by empty project activation fields', async () => {
    scope = 'home';
    target = resolveScopedEnvPath(scope, root);
    writeFileSync(
      target,
      serializeEnv({
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        WEBHOOK_SECRET: webhookSecret,
      })
    );
    writeFileSync(
      resolveScopedEnvPath('project', root),
      serializeEnv({
        GITHUB_APP_ID: '',
        GITHUB_APP_PRIVATE_KEY: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
      })
    );
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    try {
      expect(await run()).toBe(1);
      expect(readdirSync(dirname(target))).toEqual(['.env']);
    } finally {
      platforms.mockRestore();
    }
  });

  const effectivePatCases = GITHUB_APP_CREDENTIAL_KEYS.flatMap(key => [
    ...(['add', 'update', 'fresh'] as const).flatMap(mode =>
      (['home', 'project'] as const).map(selectedScope => ({
        key,
        mode,
        selectedScope,
        layer: 'inherited' as const,
      }))
    ),
    ...(['update', 'fresh'] as const).flatMap(mode => [
      { key, mode, selectedScope: 'project' as const, layer: 'home-partial' as const },
      { key, mode, selectedScope: 'home' as const, layer: 'home-complete' as const },
    ]),
  ]);
  it.each(effectivePatCases)(
    'preserves effective PAT over $layer $key ($mode, $selectedScope)',
    async scenario => {
      scope = scenario.selectedScope;
      setupMode = scenario.mode;
      target = resolveScopedEnvPath(scope, root);
      const credential = {
        [scenario.key]:
          scenario.key === 'GITHUB_APP_PRIVATE_KEY'
            ? privateKey
            : scenario.key === 'GITHUB_APP_PRIVATE_KEY_PATH'
              ? keyPath
              : '123',
      };
      const inheritedEnv = scenario.layer === 'inherited' ? credential : {};
      const home =
        scenario.layer === 'home-complete'
          ? {
              GITHUB_APP_ID: '123',
              GITHUB_APP_PRIVATE_KEY: privateKey,
              WEBHOOK_SECRET: webhookSecret,
              ...credential,
            }
          : scenario.layer === 'home-partial'
            ? credential
            : {};
      const savedPat = {
        GITHUB_TOKEN: pat,
        WEBHOOK_SECRET: webhookSecret,
        GITHUB_APP_ID: '',
        GITHUB_APP_PRIVATE_KEY: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
        CUSTOM_KEY: 'keep',
      };
      const homePath = resolveScopedEnvPath('home', root);
      const projectPath = resolveScopedEnvPath('project', root);
      writeFileSync(
        homePath,
        serializeEnv(scenario.layer === 'inherited' && scope === 'home' ? savedPat : home)
      );
      writeFileSync(projectPath, serializeEnv(savedPat));
      const original = readFileSync(target, 'utf8');
      const otherPath = scope === 'home' ? projectPath : homePath;
      const otherOriginal = readFileSync(otherPath, 'utf8');
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await setupCommand({ repoPath: root, scope, providers: [], inheritedEnv })).toBe(0);
        const effective = {
          ...inheritedEnv,
          ...parseDotenv(readFileSync(homePath, 'utf8')),
          ...parseDotenv(readFileSync(projectPath, 'utf8')),
        };
        expect(selectGitHubAuthMode(effective)).toEqual({ kind: 'pat' });
        expect(loadGitHubAppConfig(effective)).toBeNull();
        expect(effective.GITHUB_TOKEN).toBe(pat);
        expect(effective.CUSTOM_KEY).toBe('keep');
        expect(readFileSync(otherPath, 'utf8')).toBe(otherOriginal);
        const backups = Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(target)));
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dirname(target), backups[0]), 'utf8')).toBe(original);
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each([false, true])(
    'previews a PAT switch from the startup environment (inherited PAT=%j)',
    async inheritedPat => {
      const original = serializeEnv({ GITHUB_TOKEN: pat, WEBHOOK_SECRET: webhookSecret });
      writeFileSync(target, original);
      const prior = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = pat;
      try {
        const inheritedEnv = inheritedPat ? { GITHUB_TOKEN: pat } : {};
        expect(await setupCommand({ repoPath: root, scope, providers: [], inheritedEnv })).toBe(
          inheritedPat ? 1 : 0
        );
        if (inheritedPat) {
          expect(readFileSync(target, 'utf8')).toBe(original);
          expect(readdirSync(dirname(target))).toEqual(['.env']);
        } else {
          const effective = { ...inheritedEnv, ...read() };
          expect(selectGitHubAuthMode(effective)).toEqual({ kind: 'app' });
          expect(loadGitHubAppConfig(effective)).toMatchObject({ appId: '123', privateKey });
        }
      } finally {
        if (prior === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = prior;
      }
    }
  );

  it('rejects inherited PAT beside a proposed App before writing', async () => {
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = pat;
    try {
      expect(await run()).toBe(1);
      expect(existsSync(target)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prior;
    }
  });

  it.each(['home', 'relative'] as const)(
    'validates and stores the absolute private key path from a %s path',
    async form => {
      const homeRoot =
        form === 'home' ? mkdtempSync(join(homedir(), 'archon-setup-key-')) : undefined;
      const absolutePath = homeRoot ? join(homeRoot, 'app.pem') : keyPath;
      writeFileSync(absolutePath, privateKey);
      try {
        keyPath =
          form === 'home'
            ? `  ~/${relative(homedir(), absolutePath)}  `
            : `  ${relative(process.cwd(), absolutePath)}  `;
        expect(await run()).toBe(0);
        expect(keyValidation).toEqual([undefined]);
        expect(read().GITHUB_APP_PRIVATE_KEY_PATH).toBe(resolve(absolutePath));
        expect(loadGitHubAppConfig(read())?.privateKey).toBe(privateKey);
      } finally {
        if (homeRoot) await removeTempTree(homeRoot);
      }
    }
  );

  it.each([...GITHUB_APP_CREDENTIAL_KEYS])(
    'rejects a PAT proposal when the startup environment carries %s',
    async key => {
      authMode = 'pat';
      const inheritedEnv = {
        [key]:
          key === 'GITHUB_APP_PRIVATE_KEY'
            ? privateKey
            : key === 'GITHUB_APP_PRIVATE_KEY_PATH'
              ? keyPath
              : '123',
      };
      expect(await setupCommand({ repoPath: root, scope, providers: [], inheritedEnv })).toBe(1);
      expect(existsSync(target)).toBe(false);
    }
  );

  it.each(['GITHUB_TOKEN', 'WEBHOOK_SECRET'])(
    'rejects a home PAT proposal disabled by a blank project %s',
    async key => {
      authMode = 'pat';
      scope = 'home';
      target = resolveScopedEnvPath(scope, root);
      const projectPath = resolveScopedEnvPath('project', root);
      const original = serializeEnv({ [key]: '' });
      writeFileSync(projectPath, original);
      expect(await run()).toBe(1);
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(projectPath, 'utf8')).toBe(original);
    }
  );

  it.each(['app', 'pat'] as const)(
    '%s setup persists the selected allowlist and permits an explicitly empty list',
    async mode => {
      authMode = mode;
      allowedUsers = 'Alice,bob';
      expect(await run()).toBe(0);
      expect(read().GITHUB_ALLOWED_USERS).toBe('Alice,bob');
      allowedUsers = '';
      expect(await run(true)).toBe(0);
      expect(read().GITHUB_ALLOWED_USERS).toBeUndefined();
    }
  );

  it('App reruns retain an existing allowlist unless forced', async () => {
    allowedUsers = 'new-user';
    writeFileSync(target, 'GITHUB_ALLOWED_USERS=existing-user\n');
    expect(await run()).toBe(0);
    expect(read().GITHUB_ALLOWED_USERS).toBe('existing-user');
    expect(await run(true)).toBe(0);
    expect(read().GITHUB_ALLOWED_USERS).toBe('new-user');
  });

  it('cancelling the App allowlist prompt leaves the env file untouched', async () => {
    allowedUsers = cancelled;
    const original = 'CUSTOM_KEY=keep\n';
    writeFileSync(target, original);
    expect(await run()).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(output).toContain('Setup cancelled.');
    expect(Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(target)))).toEqual([]);
  });

  it.each([
    ['"', 'fresh'],
    ["'", 'fresh'],
    ['`', 'fresh'],
    ['"', 'force'],
    ["'", 'force'],
    ['`', 'force'],
    ['"', 'merge'],
    ["'", 'merge'],
    ['`', 'merge'],
  ] as const)(
    'preserves a %s mixed-quote App secret and display name on %s writes',
    async (quote, path) => {
      webhookSecret = quote + ['"', "'", '`'].filter(q => q !== quote).join('middle') + 'tail';
      botDisplayName = 'Bot' + quote;
      if (path !== 'fresh') writeFileSync(target, 'CUSTOM_KEY=keep\n');
      expect(await run(path === 'force')).toBe(0);
      const env = read();
      expect(env.WEBHOOK_SECRET).toBe(webhookSecret);
      expect(env.BOT_DISPLAY_NAME).toBe(botDisplayName);
      expect(selectGitHubAuthMode(env)).toEqual({ kind: 'app' });
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      if (path === 'merge') expect(env.CUSTOM_KEY).toBe('keep');
      else expect(env.CUSTOM_KEY).toBeUndefined();
      expect(output.join('\n')).not.toContain(webhookSecret);
    }
  );

  it('rejects an unrepresentable complete env document before writing or reporting success', async () => {
    webhookSecret = '\"single\'back`tick';
    botDisplayName = '\'name`end"';
    expect(await run()).toBe(1);
    expect(existsSync(target)).toBe(false);
    const messages = output.join('\n');
    expect(messages).toContain('Cannot serialize env without changing its values');
    expect(messages).not.toContain('Configuration written');
    expect(messages).not.toContain(webhookSecret);
  });

  it('writes an App webhook secret containing every quote delimiter', async () => {
    webhookSecret = '\"single\'back`tick';
    expect(await run()).toBe(0);
    expect(read().WEBHOOK_SECRET).toBe(webhookSecret);
    expect(selectGitHubAuthMode(read())).toEqual({ kind: 'app' });
    expect(output.join('\n')).not.toContain(webhookSecret);
  });

  it.each(['path', 'inline'] as const)(
    'rejects an EC private key from %s before writing env',
    async source => {
      keySource = source;
      keyPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      writeFileSync(keyPath, keyPem);
      expect(await run()).toBe(0);
      expect(keyValidation).toEqual(['Use an RSA PEM private key']);
      expect(existsSync(target)).toBe(false);
      expect(output).toContain('Setup cancelled.');
    }
  );

  it.each(['PAT', 'dual'] as const)(
    'confirms a %s to App switch, backs up and preserves unrelated values',
    async prior => {
      const original =
        `GITHUB_TOKEN=${pat}\nGH_TOKEN=${pat}\nWEBHOOK_SECRET=old-webhook\nCUSTOM_KEY=keep\nCUSTOM_PATH='C:\\new folder\\custom'\n` +
        (prior === 'dual'
          ? 'GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=/old.pem\nGITHUB_APP_INSTALLATION_ID=456\n'
          : '');
      writeFileSync(target, original);
      expect(await run()).toBe(0);
      expect(read()).toMatchObject({
        GITHUB_APP_ID: '123',
        CUSTOM_KEY: 'keep',
        CUSTOM_PATH: String.raw`C:\new folder\custom`,
        WEBHOOK_SECRET: webhookSecret,
      });
      expect(read().GITHUB_TOKEN).toBeUndefined();
      expect(read().GH_TOKEN).toBeUndefined();
      expect(read().GITHUB_APP_INSTALLATION_ID).toBeUndefined();
      expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '123', privateKey });
      const backups = Array.from(
        new Bun.Glob('.env.archon-backup-*').scanSync(join(root, '.archon'))
      );
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(root, '.archon', backups[0]), 'utf8')).toBe(original);
    }
  );

  it.each([false, cancelled])(
    'leaves the target untouched when switching is declined or cancelled (%s)',
    async answer => {
      switchAnswer = answer;
      const original = `GITHUB_TOKEN=${pat}\nCUSTOM_KEY=keep\n`;
      writeFileSync(target, original);
      expect(await run()).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(
        Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(root, '.archon')))
      ).toHaveLength(0);
    }
  );

  it.each([false, true])(
    'same-mode App rerun preserves credentials unless force=%s',
    async force => {
      writeFileSync(
        target,
        `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\nWEBHOOK_SECRET=old-webhook\nCUSTOM_KEY=keep\n`
      );
      switchAnswer = false;
      expect(checkExistingConfig(target)?.platforms.github).toBe(true);
      expect(await run(force)).toBe(0);
      expect(read().GITHUB_APP_ID).toBe(force ? '123' : '999');
      expect(read().WEBHOOK_SECRET).toBe(force ? webhookSecret : 'old-webhook');
      if (force) expect(read().CUSTOM_KEY).toBeUndefined();
      else expect(read().CUSTOM_KEY).toBe('keep');
    }
  );

  it.each(['path', 'inline'] as const)(
    'same-mode reruns preserve the effective %s key across both proposed sources unless forced',
    async existingSource => {
      const oldKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const oldPath = join(root, 'old.pem');
      writeFileSync(oldPath, oldKey);
      const original = serializeEnv({
        GITHUB_APP_ID: '999',
        [existingSource === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY']:
          existingSource === 'path' ? oldPath : oldKey,
      });
      for (const proposedSource of ['path', 'inline'] as const) {
        keySource = proposedSource;
        for (const force of [false, true]) {
          writeFileSync(target, original);
          expect(await run(force)).toBe(0);
          expect(loadGitHubAppConfig(read())?.privateKey).toBe(force ? privateKey : oldKey);
        }
      }
    }
  );

  it.each([
    ['GITHUB_APP_SLUG', 'old-app'],
    ['GITHUB_APP_INSTALLATION_ID', '999'],
    ['GITHUB_APP_CLIENT_ID', 'Iv1.old'],
    ['GITHUB_APP_ID', '999'],
    ['GITHUB_APP_PRIVATE_KEY_PATH', 'path'],
    ['GITHUB_APP_PRIVATE_KEY', 'inline'],
  ])('Add collects usable App authentication when only %s exists', async (key, value) => {
    setupMode = 'add';
    const original = serializeEnv({
      [key]: value === 'path' ? '/stale.pem' : value === 'inline' ? privateKey : value,
      CUSTOM_KEY: 'keep',
    });
    writeFileSync(target, original);
    expect(checkExistingConfig(target)?.platforms.github).toBe(false);
    if (['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_PRIVATE_KEY'].includes(key)) {
      switchAnswer = false;
      expect(await run()).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe(original);
      switchAnswer = true;
    }
    expect(await run()).toBe(0);
    expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '123', privateKey });
    expect(read().GITHUB_APP_PRIVATE_KEY_PATH).toBe(keyPath);
    expect(read().GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(read().CUSTOM_KEY).toBe('keep');
    const backups = Array.from(
      new Bun.Glob('.env.archon-backup-*').scanSync(join(root, '.archon'))
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(root, '.archon', backups[0]), 'utf8')).toBe(original);
  });

  it.each(['home', 'project'] as const)(
    'refuses conflicting credentials in the other scope when writing %s',
    async selectedScope => {
      scope = selectedScope;
      target = resolveScopedEnvPath(scope, root);
      const other = resolveScopedEnvPath(scope === 'home' ? 'project' : 'home', root);
      for (const [selectedMode, opposite] of [
        ['app', `GITHUB_TOKEN=${pat}\n`],
        ['app', `GH_TOKEN=${pat}\n`],
        ['pat', `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\n`],
      ] as const) {
        authMode = selectedMode;
        for (const force of [false, true]) {
          writeFileSync(target, 'CUSTOM_KEY=keep\n');
          writeFileSync(other, opposite);
          expect(await run(force)).toBe(1);
          expect(readFileSync(target, 'utf8')).toBe('CUSTOM_KEY=keep\n');
          expect(readFileSync(other, 'utf8')).toBe(opposite);
          expect(output.join('\n')).toContain(other);
          expect(
            Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(root, '.archon')))
          ).toHaveLength(0);
          expect(
            Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(root, 'home')))
          ).toHaveLength(0);
        }
      }
    }
  );

  it.each(['app', 'pat'] as const)(
    'Add completes %s authentication missing its webhook',
    async selectedMode => {
      setupMode = 'add';
      authMode = selectedMode;
      writeFileSync(
        target,
        serializeEnv(
          selectedMode === 'app'
            ? { GITHUB_APP_ID: '999', GITHUB_APP_PRIVATE_KEY_PATH: keyPath }
            : { GITHUB_TOKEN: 'old-token' }
        )
      );
      expect(checkExistingConfig(target)?.platforms.github).toBe(false);
      expect(await run()).toBe(0);
      expect(selectGitHubAuthMode(read())).toEqual({ kind: selectedMode });
      if (selectedMode === 'app')
        expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '999', privateKey });
      else expect(read().GITHUB_TOKEN).toBe('old-token');
    }
  );

  it.each(['app', 'pat'] as const)(
    'Add resolves dual authentication after confirmation into %s',
    async selectedMode => {
      setupMode = 'add';
      authMode = selectedMode;
      const original = serializeEnv({
        GITHUB_APP_ID: '999',
        GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        GITHUB_TOKEN: pat,
        WEBHOOK_SECRET: 'old-webhook',
        CUSTOM_KEY: 'keep',
      });
      writeFileSync(target, original);
      expect(checkExistingConfig(target)?.platforms.github).toBe(false);
      switchAnswer = false;
      expect(await run()).toBe(0);
      expect(readFileSync(target, 'utf8')).toBe(original);
      switchAnswer = true;
      expect(await run()).toBe(0);
      expect(selectGitHubAuthMode(read())).toEqual({ kind: selectedMode });
      expect(read().CUSTOM_KEY).toBe('keep');
      if (selectedMode === 'app')
        expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '123', privateKey });
    }
  );

  it('refuses unresolved selected-file dual mode even when GitHub is not selected in Add', async () => {
    setupMode = 'add';
    const original = serializeEnv({
      GITHUB_APP_ID: '999',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_TOKEN: pat,
      WEBHOOK_SECRET: webhookSecret,
    });
    writeFileSync(target, original);
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    try {
      expect(await run()).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(
        Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(root, '.archon')))
      ).toHaveLength(0);
    } finally {
      platforms.mockRestore();
    }
  });

  it.each(['home', 'project'] as const)(
    'force clears selected-file dual mode without selecting GitHub in %s',
    async selectedScope => {
      scope = selectedScope;
      target = resolveScopedEnvPath(scope, root);
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        for (const mode of ['fresh', 'add', 'update'] as const) {
          setupMode = mode;
          for (const source of ['path', 'inline'] as const) {
            const original = serializeEnv({
              GITHUB_APP_ID: '999',
              [source === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY']:
                source === 'path' ? keyPath : privateKey,
              GITHUB_TOKEN: pat,
              WEBHOOK_SECRET: webhookSecret,
              CUSTOM_KEY: `${mode}-${source}`,
            });
            writeFileSync(target, original);
            expect(await run(true)).toBe(0);
            expect(selectGitHubAuthMode(read())).toEqual({ kind: 'none' });
            for (const key of [...GITHUB_APP_KEYS, 'GH_TOKEN', 'GITHUB_TOKEN'])
              expect(read()[key]).toBeUndefined();
            const backups = Array.from(
              new Bun.Glob('.env.archon-backup-*').scanSync(dirname(target))
            );
            expect(backups.length).toBeGreaterThan(0);
            expect(
              backups.some(file => readFileSync(join(dirname(target), file), 'utf8') === original)
            ).toBe(true);
          }
        }
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(['home', 'project'] as const)(
    'Add collects credentials for each blank authentication field in %s',
    async selectedScope => {
      scope = selectedScope;
      target = resolveScopedEnvPath(scope, root);
      setupMode = 'add';
      for (const key of [
        'GITHUB_TOKEN',
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_APP_PRIVATE_KEY_PATH',
      ]) {
        authMode = key === 'GITHUB_TOKEN' ? 'pat' : 'app';
        for (const whitespace of [' ', '   ', '\t']) {
          const original = serializeEnv({
            ...(authMode === 'pat'
              ? { GITHUB_TOKEN: pat }
              : {
                  GITHUB_APP_ID: '999',
                  [key === 'GITHUB_APP_PRIVATE_KEY' ? key : 'GITHUB_APP_PRIVATE_KEY_PATH']:
                    key === 'GITHUB_APP_PRIVATE_KEY' ? privateKey : keyPath,
                }),
            WEBHOOK_SECRET: webhookSecret,
            CUSTOM_KEY: 'keep',
            [key]: whitespace,
          });
          writeFileSync(target, original);
          expect(checkExistingConfig(target)?.platforms.github).toBe(false);
          initialAuthMode = undefined;
          expect(await run()).toBe(0);
          expect(initialAuthMode).toBe('pat');
          expect(selectGitHubAuthMode(read())).toEqual({ kind: authMode });
          expect(read().CUSTOM_KEY).toBe('keep');
          if (authMode === 'app')
            expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '123', privateKey });
          else expect(read().GITHUB_TOKEN).toBe(pat);
        }
      }
    }
  );

  it('Add resolves a raw conflict even when the PAT is blank', async () => {
    setupMode = 'add';
    writeFileSync(
      target,
      serializeEnv({
        GITHUB_APP_ID: '999',
        GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
        GITHUB_TOKEN: '   ',
        WEBHOOK_SECRET: webhookSecret,
      })
    );
    expect(checkExistingConfig(target)?.platforms.github).toBe(false);
    expect(await run()).toBe(0);
    expect(read().GITHUB_TOKEN).toBeUndefined();
    expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '123', privateKey });
  });

  it.each(['path', 'inline'] as const)(
    'Add retains a usable %s key when the alternate source is blank',
    async source => {
      setupMode = 'add';
      writeFileSync(
        target,
        serializeEnv({
          GITHUB_APP_ID: '999',
          GITHUB_APP_PRIVATE_KEY: source === 'inline' ? privateKey : '   ',
          GITHUB_APP_PRIVATE_KEY_PATH: source === 'path' ? keyPath : '   ',
          WEBHOOK_SECRET: webhookSecret,
        })
      );
      expect(checkExistingConfig(target)?.platforms.github).toBe(true);
      expect(await run()).toBe(0);
      expect(initialAuthMode).toBeUndefined();
      expect(loadGitHubAppConfig(read())).toMatchObject({ appId: '999', privateKey });
    }
  );

  it.each(['home', 'project'] as const)(
    'refuses runtime-active whitespace in the other scope from %s',
    async selectedScope => {
      scope = selectedScope;
      target = resolveScopedEnvPath(scope, root);
      const other = resolveScopedEnvPath(scope === 'home' ? 'project' : 'home', root);
      for (const key of [
        'GITHUB_TOKEN',
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_APP_PRIVATE_KEY_PATH',
      ]) {
        authMode = key === 'GITHUB_TOKEN' ? 'app' : 'pat';
        for (const whitespace of [' ', '   ', '\t']) {
          for (const force of [false, true]) {
            const original = serializeEnv({ [key]: whitespace });
            writeFileSync(other, original);
            writeFileSync(target, 'CUSTOM_KEY=keep\n');
            expect(await run(force)).toBe(1);
            expect(readFileSync(other, 'utf8')).toBe(original);
            expect(readFileSync(target, 'utf8')).toBe('CUSTOM_KEY=keep\n');
            for (const dir of [join(root, 'home'), join(root, '.archon')])
              expect(Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dir))).toHaveLength(
                0
              );
          }
        }
      }
    }
  );

  it('writes a fresh App webhook ending in a backslash', async () => {
    const value = 'C:\\folder#name\\';
    const secret = spyOn(prompts, 'password').mockImplementation(async options =>
      options.message === 'GitHub webhook secret:' ? value : pat
    );
    try {
      expect(await run()).toBe(0);
      expect(read().WEBHOOK_SECRET).toBe(value);
    } finally {
      secret.mockRestore();
    }
  });

  it.each(['pat', 'app'] as const)(
    'generates %s settings with a webhook ending in a backslash',
    selectedMode => {
      const value = 'C:\\folder#name\\';
      const content = generateEnvContent({
        ai: { claude: false, codex: false, pi: false, defaultAssistant: undefined },
        platforms: { github: true, telegram: false, slack: false },
        github:
          selectedMode === 'pat'
            ? { mode: 'pat', token: pat, webhookSecret: value, allowedUsers: '' }
            : {
                mode: 'app',
                appId: '123',
                privateKey: { source: 'path', value: keyPath },
                webhookSecret: value,
                allowedUsers: '',
              },
        botDisplayName: 'Archon',
      });
      expect(parseDotenv(content).WEBHOOK_SECRET).toBe(value);
    }
  );

  it('Add still checks the other scope when retaining existing App credentials', async () => {
    setupMode = 'add';
    const original = `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\n`;
    writeFileSync(target, original);
    const other = join(root, 'home', '.env');
    writeFileSync(other, `GITHUB_TOKEN=${pat}\n`);
    expect(await run()).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(output.join('\n')).toContain(other);
  });

  it('add mode recognizes and retains existing App configuration', async () => {
    setupMode = 'add';
    writeFileSync(
      target,
      `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\nWEBHOOK_SECRET=old-webhook\n`
    );
    expect(await run()).toBe(0);
    expect(read().GITHUB_APP_ID).toBe('999');
    expect(read().GITHUB_TOKEN).toBeUndefined();
  });

  it('same-mode PAT reruns keep non-empty credentials and webhook settings', async () => {
    authMode = 'pat';
    switchAnswer = false;
    writeFileSync(
      target,
      'GITHUB_TOKEN=existing-token\nGH_TOKEN=existing-token\nWEBHOOK_SECRET=existing-secret\n'
    );
    expect(await run()).toBe(0);
    expect(read()).toMatchObject({
      GITHUB_TOKEN: 'existing-token',
      GH_TOKEN: 'existing-token',
      WEBHOOK_SECRET: 'existing-secret',
    });
  });

  it('an inline App key survives a same-mode merge and remains usable', async () => {
    keySource = 'inline';
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    expect(loadGitHubAppConfig(read())).toMatchObject({ privateKey });
  });

  it('PAT remains the default and a confirmed App to PAT switch removes App auth keys', async () => {
    authMode = 'pat';
    writeFileSync(
      target,
      `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\nGITHUB_APP_SLUG=old-app\nGITHUB_APP_INSTALLATION_ID=456\nGITHUB_APP_CLIENT_ID=Iv1.old\nTOKEN_ENCRYPTION_KEY=keep-encryption\nWEBHOOK_SECRET=keep-webhook\nCUSTOM_KEY=keep\n`
    );
    expect(await run()).toBe(0);
    expect(read()).toMatchObject({ GITHUB_TOKEN: pat, GH_TOKEN: pat, CUSTOM_KEY: 'keep' });
    expect(read().GITHUB_APP_ID).toBeUndefined();
    expect(read().GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined();
    expect(read().GITHUB_APP_SLUG).toBeUndefined();
    expect(read().GITHUB_APP_INSTALLATION_ID).toBeUndefined();
    expect(read().GITHUB_APP_CLIENT_ID).toBeUndefined();
    expect(read().TOKEN_ENCRYPTION_KEY).toBe('keep-encryption');
    expect(read().WEBHOOK_SECRET).toBe('keep-webhook');
    expect(initialAuthMode).toBe('pat');
    expect(output.join('\n')).not.toContain(pat);
    expect(output.join('\n')).not.toContain(read().WEBHOOK_SECRET);
  });
});
