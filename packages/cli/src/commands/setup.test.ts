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
  copyArchonSkill,
  detectClaudeExecutablePath,
} from './setup';
import * as setupModule from './setup';

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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
        botDisplayName: 'HarnessLab',
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
    it('should create skill files in target directory', () => {
      const target = join(TEST_DIR, 'skill-target');
      mkdirSync(target, { recursive: true });

      copyArchonSkill(target);

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

    it('should write non-empty content to skill files', () => {
      const target = join(TEST_DIR, 'skill-target-content');
      mkdirSync(target, { recursive: true });

      copyArchonSkill(target);

      const content = readFileSync(
        join(target, '.claude', 'skills', 'archon', 'SKILL.md'),
        'utf-8'
      );
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('archon');
    });

    it('should overwrite existing skill files', () => {
      const target = join(TEST_DIR, 'skill-target-overwrite');
      const skillDir = join(target, '.claude', 'skills', 'archon');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'old content');

      copyArchonSkill(target);

      const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
      expect(content).not.toBe('old content');
    });

    it('should create skill files even when target directory does not exist', () => {
      const target = join(TEST_DIR, 'non-existent-parent', 'skill-target-new');
      // Do NOT pre-create target — copyArchonSkill must handle it

      copyArchonSkill(target);

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
