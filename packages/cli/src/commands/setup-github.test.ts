/**
 * Tests for the GitHub step of the setup wizard
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { generateKeyPairSync } from 'node:crypto';
import * as git from '@archon/git';
import {
  GITHUB_APP_CREDENTIAL_KEYS,
  selectGitHubAuthMode,
} from '@archon/core/utils/github-auth-mode';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';
import { setupCommand } from './setup';
import { generateWebhookSecret } from './setup-github';
import {
  GITHUB_APP_KEYS,
  checkExistingConfig,
  generateEnvContent,
  serializeEnv,
  resolveScopedEnvPath,
} from './setup-env';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';
import { parse as parseDotenv } from 'dotenv';

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
  let passwordMessages: string[];
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
    passwordMessages = [];
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
      passwordMessages.push(options.message);
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

  it.each(['telegram', 'slack'] as const)(
    'Add keeps existing %s credentials and prompts only for the newly selected connection',
    async existingPlatform => {
      setupMode = 'add';
      const existingTelegram = existingPlatform === 'telegram';
      writeFileSync(
        target,
        serializeEnv(
          existingTelegram
            ? { TELEGRAM_BOT_TOKEN: '123456:old-telegram' }
            : { SLACK_BOT_TOKEN: 'xoxb-old-slack', SLACK_APP_TOKEN: 'xapp-old-slack' }
        )
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([
        existingTelegram ? 'slack' : 'telegram',
      ]);
      try {
        expect(await run()).toBe(0);
        expect(passwordMessages).toEqual(
          existingTelegram
            ? ['Enter your Slack Bot Token (xoxb-...):', 'Enter your Slack App Token (xapp-...):']
            : ['Enter your Telegram Bot Token:']
        );
        expect(read()).toMatchObject({
          TELEGRAM_BOT_TOKEN: existingTelegram ? '123456:old-telegram' : '123456:new-telegram',
          SLACK_BOT_TOKEN: existingTelegram ? 'xoxb-new-slack' : 'xoxb-old-slack',
          SLACK_APP_TOKEN: existingTelegram ? 'xapp-new-slack' : 'xapp-old-slack',
        });
        expect(read().GITHUB_APP_ID).toBeUndefined();
        expect(read().GITHUB_TOKEN).toBeUndefined();
        expect(output.find(message => message.startsWith('Claude:'))).toContain(
          `Platforms: ${existingTelegram ? 'Telegram' : 'Slack'}`
        );
        expect(output.find(message => message.startsWith('AI:'))).toContain(
          'Platforms: Telegram, Slack'
        );
      } finally {
        platforms.mockRestore();
      }
    }
  );

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
        expect(passwordMessages.includes('Enter your Telegram Bot Token:')).toBe(force);
        expect(passwordMessages.includes('Enter your Slack Bot Token (xoxb-...):')).toBe(force);
        expect(passwordMessages.includes('Enter your Slack App Token (xapp-...):')).toBe(force);
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
      expect(prompts.confirm).toHaveBeenCalledWith({
        message: `Replace existing GitHub authentication with ${selectedMode === 'app' ? 'GitHub App' : 'personal access token'} mode? A backup will be saved.`,
        initialValue: false,
      });
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
