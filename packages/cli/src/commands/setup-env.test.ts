/**
 * Tests for the archon-owned env file: detection, generation, and scoped writes
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  GITHUB_APP_KEYS,
  checkExistingConfig,
  generateEnvContent,
  writeScopedEnv,
  serializeEnv,
  resolveScopedEnvPath,
} from './setup-env';
import { removeTempTree } from '@archon/paths/test-utils';
import { parse as parseDotenv } from 'dotenv';

// Test directory for file operations
const TEST_DIR = join(tmpdir(), 'archon-setup-env-test-' + Date.now());

describe('setup env file', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(TEST_DIR);
  });

  describe('checkExistingConfig', () => {
    it('should return null when no .env file exists', () => {
      const result = checkExistingConfig(join(TEST_DIR, 'nonexistent', '.env'));

      expect(result).toBeNull();
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

      const result = checkExistingConfig(envPath);

      expect(result).not.toBeNull();
      expect(result?.hasClaude).toBe(true);
      expect(result?.hasCodex).toBe(true);
      expect(result?.platforms.telegram).toBe(true);
      expect(result?.platforms.github).toBe(false);
      expect(result?.platforms.slack).toBe(false);
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

    it('tells a forge-plugin token apart from the GitHub webhook platform', () => {
      const envDir = join(TEST_DIR, '.archon-forge');
      mkdirSync(envDir, { recursive: true });
      const envPath = join(envDir, '.env');

      writeFileSync(envPath, 'GH_TOKEN=ghp_forge\n');
      expect(checkExistingConfig(envPath)).toMatchObject({
        platforms: { github: false },
      });

      writeFileSync(envPath, 'GH_TOKEN=ghp_x\nGITHUB_TOKEN=ghp_x\nWEBHOOK_SECRET=secret\n');
      expect(checkExistingConfig(envPath)).toMatchObject({
        platforms: { github: true },
      });
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

    it.each([
      { authType: 'apiKey' as const, key: 'CLAUDE_API_KEY', otherKey: 'CLAUDE_CODE_OAUTH_TOKEN' },
      {
        authType: 'oauthToken' as const,
        key: 'CLAUDE_CODE_OAUTH_TOKEN',
        otherKey: 'CLAUDE_API_KEY',
      },
    ])('writes only the selected Claude $authType credential', ({ authType, key, otherKey }) => {
      const env = parseDotenv(
        generateEnvContent({
          ai: {
            claude: true,
            claudeAuthType: authType,
            claudeApiKey: 'api-key-value',
            claudeOauthToken: 'oauth-token-value',
            codex: false,
            pi: false,
            defaultAssistant: 'claude',
          },
          platforms: { github: false, telegram: false, slack: false },
          botDisplayName: 'Archon',
        })
      );

      expect(env[key]).toBe(authType === 'apiKey' ? 'api-key-value' : 'oauth-token-value');
      expect(env.CLAUDE_USE_GLOBAL_AUTH).toBe('false');
      expect(env[otherKey]).toBeUndefined();
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

  afterEach(async () => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    await removeTempTree(ROOT);
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

describe('GITHUB_APP_KEYS', () => {
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
});
