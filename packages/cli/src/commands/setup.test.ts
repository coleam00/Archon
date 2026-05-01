/**
 * Tests for setup command utility functions
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkExistingConfig,
  generateEnvContent,
  generateWebhookSecret,
  spawnTerminalWithSetup,
  detectClaudeExecutablePath,
  writeScopedEnv,
  serializeEnv,
  resolveScopedEnvPath,
} from './setup';
import * as setupModule from './setup';
import { copyArchonSkill } from './skill';
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
CODEX_ID_TOKEN=token1
CODEX_ACCESS_TOKEN=token2
CODEX_REFRESH_TOKEN=token3
CODEX_ACCOUNT_ID=account1
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
      expect(result?.platforms.discord).toBe(false);
      expect(result?.hasDatabase).toBe(false);

      if (originalHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalHome;
      }
    });

    it('should detect PostgreSQL database configuration', () => {
      const envDir = join(TEST_DIR, '.archon2');
      mkdirSync(envDir, { recursive: true });
      const envPath = join(envDir, '.env');

      writeFileSync(envPath, 'DATABASE_URL=postgresql://localhost:5432/test');

      const originalHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = envDir;

      const result = checkExistingConfig();

      expect(result).not.toBeNull();
      expect(result?.hasDatabase).toBe(true);

      if (originalHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalHome;
      }
    });
  });

  describe('generateEnvContent', () => {
    it('should generate valid .env content for SQLite configuration', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
          discord: false,
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('# Using SQLite (default)');
      expect(content).toContain('CLAUDE_USE_GLOBAL_AUTH=true');
      expect(content).toContain('DEFAULT_AI_ASSISTANT=claude');
      // PORT is intentionally commented out — server and Vite both default to 3090 when unset (#1152).
      expect(content).toContain('# PORT=3090');
      expect(content).not.toMatch(/^PORT=/m);
      expect(content).not.toContain('DATABASE_URL=');
    });

    it('should generate valid .env content for PostgreSQL configuration', () => {
      const content = generateEnvContent({
        database: { type: 'postgresql', url: 'postgresql://localhost:5432/archon' },
        ai: {
          claude: true,
          claudeAuthType: 'apiKey',
          claudeApiKey: 'sk-test-key',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
          discord: false,
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('DATABASE_URL=postgresql://localhost:5432/archon');
      expect(content).toContain('CLAUDE_USE_GLOBAL_AUTH=false');
      expect(content).toContain('CLAUDE_API_KEY=sk-test-key');
    });

    it('emits CLAUDE_BIN_PATH when claudeBinaryPath is configured', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          claudeBinaryPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: { github: false, telegram: false, slack: false, discord: false },
        botDisplayName: 'Archon',
      });

      expect(content).toContain(
        'CLAUDE_BIN_PATH=/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'
      );
    });

    it('omits CLAUDE_BIN_PATH when not configured', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: { github: false, telegram: false, slack: false, discord: false },
        botDisplayName: 'Archon',
      });

      expect(content).not.toContain('CLAUDE_BIN_PATH=');
    });

    it('should include platform configurations', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: true,
          telegram: true,
          slack: false,
          discord: false,
        },
        github: {
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
        database: { type: 'sqlite' },
        ai: {
          claude: false,
          codex: true,
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
          discord: false,
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('CODEX_ID_TOKEN=id-token');
      expect(content).toContain('CODEX_ACCESS_TOKEN=access-token');
      expect(content).toContain('CODEX_REFRESH_TOKEN=refresh-token');
      expect(content).toContain('CODEX_ACCOUNT_ID=account-id');
      expect(content).toContain('DEFAULT_AI_ASSISTANT=codex');
    });

    it('should include custom bot display name', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
          discord: false,
        },
        botDisplayName: 'MyCustomBot',
      });

      expect(content).toContain('BOT_DISPLAY_NAME=MyCustomBot');
    });

    it('should not include bot display name when default', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
          discord: false,
        },
        botDisplayName: 'Archon',
      });

      expect(content).not.toContain('BOT_DISPLAY_NAME=');
    });

    it('should include Slack configuration', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: true,
          discord: false,
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

    it('should include Discord configuration', () => {
      const content = generateEnvContent({
        database: { type: 'sqlite' },
        ai: {
          claude: true,
          claudeAuthType: 'global',
          codex: false,
          defaultAssistant: 'claude',
        },
        platforms: {
          github: false,
          telegram: false,
          slack: false,
          discord: true,
        },
        discord: {
          botToken: 'discord-bot-token-test',
          allowedUserIds: '123456789',
        },
        botDisplayName: 'Archon',
      });

      expect(content).toContain('DISCORD_BOT_TOKEN=discord-bot-token-test');
      expect(content).toContain('DISCORD_ALLOWED_USER_IDS=123456789');
      expect(content).toContain('DISCORD_STREAMING_MODE=batch');
    });
  });

  describe('spawnTerminalWithSetup', () => {
    // Skip this test because it requires a terminal emulator to be present
    // and spawn() throws synchronously when executable is not found in PATH
    // The actual functionality is manually tested
    it.skip('should return a SpawnResult object (requires terminal emulator)', () => {
      const result = spawnTerminalWithSetup(TEST_DIR);

      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
      if (!result.success) {
        expect(result).toHaveProperty('error');
      }
    });

    it('should export spawnTerminalWithSetup function', () => {
      // Just verify the function is exported and callable
      expect(typeof spawnTerminalWithSetup).toBe('function');
    });
  });

  describe('copyArchonSkill', () => {
    it('should create skill files in target directory', async () => {
      const target = join(TEST_DIR, 'skill-target');
      mkdirSync(target, { recursive: true });

      await copyArchonSkill(target);

      expect(existsSync(join(target, '.claude', 'skills', 'archon', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(target, '.claude', 'skills', 'archon', 'guides', 'setup.md'))).toBe(
        true
      );
      expect(
        existsSync(join(target, '.claude', 'skills', 'archon', 'references', 'workflow-dag.md'))
      ).toBe(true);
      expect(
        existsSync(join(target, '.claude', 'skills', 'archon', 'examples', 'dag-workflow.yaml'))
      ).toBe(true);
    });

    it('should write non-empty content to skill files', async () => {
      const target = join(TEST_DIR, 'skill-target-content');
      mkdirSync(target, { recursive: true });

      await copyArchonSkill(target);

      const content = readFileSync(
        join(target, '.claude', 'skills', 'archon', 'SKILL.md'),
        'utf-8'
      );
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('archon');
    });

    it('should overwrite existing skill files', async () => {
      const target = join(TEST_DIR, 'skill-target-overwrite');
      const skillDir = join(target, '.claude', 'skills', 'archon');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'old content');

      await copyArchonSkill(target);

      const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
      expect(content).not.toBe('old content');
    });

    it('should create skill files even when target directory does not exist', async () => {
      const target = join(TEST_DIR, 'non-existent-parent', 'skill-target-new');
      // Do NOT pre-create target — copyArchonSkill must handle it

      await copyArchonSkill(target);

      expect(existsSync(join(target, '.claude', 'skills', 'archon', 'SKILL.md'))).toBe(true);
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
