import { describe, it, expect, spyOn } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { homedir } from 'os';
import { generateKeyPairSync } from 'node:crypto';

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
  serializeEnv,
  resolveScopedEnvPath,
} from './setup-env';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';

import { GitHubSetupFixture } from './setup-github-fixture';

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
  const fixture = new GitHubSetupFixture();
  function expectSavedAuthentication(
    env: ReturnType<GitHubSetupFixture['read']>,
    mode: GitHubSetupFixture['authMode'],
    force: boolean
  ) {
    expect(selectGitHubAuthMode(env)).toEqual({ kind: mode });
    if (mode === 'app') {
      expect(loadGitHubAppConfig(env)).toMatchObject({
        appId: force ? '123' : '999',
        privateKey: fixture.privateKey,
      });
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
    } else {
      expect(env.GITHUB_TOKEN).toBe(force ? fixture.pat : 'old-token');
    }
  }
  it.each(['telegram', 'slack'] as const)(
    'Add keeps existing %s credentials and prompts only for the newly selected connection',
    async existingPlatform => {
      fixture.setupMode = 'add';
      const existingTelegram = existingPlatform === 'telegram';
      writeFileSync(
        fixture.target,
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
        expect(await fixture.run()).toBe(0);
        expect(fixture.passwordMessages).toEqual(
          existingTelegram
            ? ['Enter your Slack Bot Token (xoxb-...):', 'Enter your Slack App Token (xapp-...):']
            : ['Enter your Telegram Bot Token:']
        );
        expect(fixture.read()).toMatchObject({
          TELEGRAM_BOT_TOKEN: existingTelegram ? '123456:old-telegram' : '123456:new-telegram',
          SLACK_BOT_TOKEN: existingTelegram ? 'xoxb-new-slack' : 'xoxb-old-slack',
          SLACK_APP_TOKEN: existingTelegram ? 'xapp-new-slack' : 'xapp-old-slack',
        });
        expect(fixture.read().GITHUB_APP_ID).toBeUndefined();
        expect(fixture.read().GITHUB_TOKEN).toBeUndefined();
        expect(fixture.output.find(message => message.startsWith('Claude:'))).toContain(
          `Platforms: ${existingTelegram ? 'Telegram' : 'Slack'}`
        );
        expect(fixture.output.find(message => message.startsWith('AI:'))).toContain(
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
      fixture.scope = selectedScope;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      fixture.setupMode = 'add';
      fixture.authMode = selectedMode;
      const original = serializeEnv({
        ...(fixture.authMode === 'app'
          ? { GITHUB_APP_ID: '999', GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath }
          : { GITHUB_TOKEN: 'old-token' }),
        WEBHOOK_SECRET: 'old-webhook',
        TELEGRAM_BOT_TOKEN: '123456:old-telegram',
        TELEGRAM_ALLOWED_USER_IDS: '111',
        SLACK_BOT_TOKEN: 'xoxb-old-slack',
        SLACK_APP_TOKEN: 'xapp-old-slack',
        SLACK_ALLOWED_USER_IDS: 'U111',
        CUSTOM_KEY: 'keep',
      });
      writeFileSync(fixture.target, original);
      expect(checkExistingConfig(fixture.target)?.platforms).toEqual({
        github: true,
        telegram: true,
        slack: true,
      });
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await fixture.run(force)).toBe(0);
        expect(fixture.passwordMessages.includes('Enter your Telegram Bot Token:')).toBe(force);
        expect(fixture.passwordMessages.includes('Enter your Slack Bot Token (xoxb-...):')).toBe(
          force
        );
        expect(fixture.passwordMessages.includes('Enter your Slack App Token (xapp-...):')).toBe(
          force
        );
        const env = fixture.read();
        expectSavedAuthentication(env, selectedMode, force);
        expect(env.WEBHOOK_SECRET).toBeTruthy();
        expect(env.TELEGRAM_BOT_TOKEN).toBe(force ? '123456:new-telegram' : '123456:old-telegram');
        expect(env.TELEGRAM_ALLOWED_USER_IDS).toBe(force ? '222' : '111');
        expect(env.SLACK_BOT_TOKEN).toBe(force ? 'xoxb-new-slack' : 'xoxb-old-slack');
        expect(env.SLACK_APP_TOKEN).toBe(force ? 'xapp-new-slack' : 'xapp-old-slack');
        expect(env.SLACK_ALLOWED_USER_IDS).toBe(force ? 'U222' : 'U111');
        if (force) expect(env.CUSTOM_KEY).toBeUndefined();
        else expect(env.CUSTOM_KEY).toBe('keep');
        expect(fixture.output.find(message => message.startsWith('AI:'))).toContain(
          'Platforms: GitHub, Telegram, Slack'
        );
        for (const value of [
          env.GITHUB_TOKEN,
          env.WEBHOOK_SECRET,
          env.TELEGRAM_BOT_TOKEN,
          env.SLACK_BOT_TOKEN,
          env.SLACK_APP_TOKEN,
          fixture.privateKey,
        ]) {
          if (value) expect(fixture.output.join('\n')).not.toContain(value);
        }
        const backups = Array.from(
          new Bun.Glob('.env.archon-backup-*').scanSync(dirname(fixture.target))
        );
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dirname(fixture.target), backups[0]), 'utf8')).toBe(original);
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(['0', '-1', 'abc', '1.2', '   '])(
    'rejects invalid App ID %j before writing',
    async value => {
      fixture.appId = value;
      expect(await fixture.run()).toBe(0);
      expect(fixture.inputValidation).toEqual(['Enter a positive decimal App ID']);
      expect(existsSync(fixture.target)).toBe(false);
    }
  );

  it('rejects a whitespace webhook secret before writing', async () => {
    fixture.webhookSecret = '   ';
    expect(await fixture.run()).toBe(0);
    expect(fixture.inputValidation).toEqual([
      undefined,
      'Enter the secret configured on your GitHub App',
    ]);
    expect(existsSync(fixture.target)).toBe(false);
  });

  it.each([
    ['app', 'GH_TOKEN', ''],
    ['app', 'GITHUB_TOKEN', ''],
    ...GITHUB_APP_KEYS.map(key => ['pat', key, ''] as const),
    ['pat', 'GITHUB_APP_CLIENT_ID', 'Iv1.old'],
    ['pat', 'GITHUB_APP_SLUG', 'old-app'],
    ['pat', 'GITHUB_APP_INSTALLATION_ID', '999'],
  ] as const)('preserves %s credentials with inactive %s=%j', async (mode, key, value) => {
    fixture.authMode = mode;
    const original = serializeEnv({
      ...(mode === 'app'
        ? { GITHUB_APP_ID: '999', GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath }
        : { GITHUB_TOKEN: 'old-token' }),
      [key]: value,
      WEBHOOK_SECRET: 'old-webhook',
      CUSTOM_KEY: 'keep',
    });
    writeFileSync(fixture.target, original);
    fixture.switchAnswer = false;
    expect(await fixture.run()).toBe(0);
    expect(fixture.output).not.toContain(
      'Setup cancelled. Existing configuration was not changed.'
    );
    const env = fixture.read();
    expect(selectGitHubAuthMode(env)).toEqual({ kind: mode });
    expect(env.WEBHOOK_SECRET).toBe('old-webhook');
    expect(env.CUSTOM_KEY).toBe('keep');
    if (mode === 'app') {
      expect(loadGitHubAppConfig(env)).toMatchObject({
        appId: '999',
        privateKey: fixture.privateKey,
      });
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
    } else {
      expect(env.GITHUB_TOKEN).toBe('old-token');
      expect(loadGitHubAppConfig(env)).toBeNull();
    }
    const backups = Array.from(
      new Bun.Glob('.env.archon-backup-*').scanSync(dirname(fixture.target))
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(fixture.target), backups[0]), 'utf8')).toBe(original);
  });

  it.each([...GITHUB_APP_CREDENTIAL_KEYS])(
    'rejects PAT beside partial %s in Add and workflow loading',
    async key => {
      fixture.setupMode = 'add';
      const env = {
        GITHUB_TOKEN: fixture.pat,
        WEBHOOK_SECRET: fixture.webhookSecret,
        [key]: 'partial',
      };
      expect(() => loadGitHubAppConfig(env)).toThrow('both App mode');
      const original = serializeEnv(env);
      writeFileSync(fixture.target, original);
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await fixture.run()).toBe(1);
        expect(readFileSync(fixture.target, 'utf8')).toBe(original);
        expect(
          Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(fixture.target)))
        ).toEqual([]);
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(['path', 'inline'] as const)(
    'writes a fresh App using %s without PAT keys or secret output',
    async source => {
      fixture.keySource = source;
      expect(await fixture.run()).toBe(0);
      const env = fixture.read();
      expect(fixture.keyValidation).toEqual([undefined]);
      expect(fixture.inputValidation).toEqual([undefined, undefined]);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.WEBHOOK_SECRET).toBe(fixture.webhookSecret);
      expect(loadGitHubAppConfig(env)).toMatchObject({
        appId: '123',
        slug: 'fixture-app',
        privateKey: fixture.privateKey,
      });
      const messages = fixture.output.join('\n');
      expect(messages).toContain('adapters/github-app-setup');
      expect(messages).not.toContain(fixture.webhookSecret);
      expect(messages).not.toContain(fixture.privateKey);
      expect(existsSync(join(fixture.root, 'home', '.env'))).toBe(false);
    }
  );

  it('loads fresh App configuration when the optional slug is unanswered', async () => {
    fixture.appSlug = '';
    expect(await fixture.run()).toBe(0);
    expect(loadGitHubAppConfig(fixture.read())?.slug).toBe('archon');
  });

  it.each(['home', 'relative'] as const)(
    'validates and stores the absolute private key path from a %s path',
    async form => {
      const homeRoot =
        form === 'home' ? mkdtempSync(join(homedir(), 'archon-setup-key-')) : undefined;
      const absolutePath = homeRoot ? join(homeRoot, 'app.pem') : fixture.keyPath;
      writeFileSync(absolutePath, fixture.privateKey);
      try {
        fixture.keyPath =
          form === 'home'
            ? `  ~/${relative(homedir(), absolutePath)}  `
            : `  ${relative(process.cwd(), absolutePath)}  `;
        expect(await fixture.run()).toBe(0);
        expect(fixture.keyValidation).toEqual([undefined]);
        expect(fixture.read().GITHUB_APP_PRIVATE_KEY_PATH).toBe(resolve(absolutePath));
        expect(loadGitHubAppConfig(fixture.read())?.privateKey).toBe(fixture.privateKey);
      } finally {
        if (homeRoot) await removeTempTree(homeRoot);
      }
    }
  );

  it.each([...GITHUB_APP_CREDENTIAL_KEYS])(
    'rejects a PAT proposal when the startup environment carries %s',
    async key => {
      fixture.authMode = 'pat';
      const inheritedEnv = {
        [key]:
          key === 'GITHUB_APP_PRIVATE_KEY'
            ? fixture.privateKey
            : key === 'GITHUB_APP_PRIVATE_KEY_PATH'
              ? fixture.keyPath
              : '123',
      };
      expect(
        await setupCommand({
          repoPath: fixture.root,
          scope: fixture.scope,
          providers: [],
          inheritedEnv,
        })
      ).toBe(1);
      expect(existsSync(fixture.target)).toBe(false);
    }
  );

  it.each(['GITHUB_TOKEN', 'WEBHOOK_SECRET'])(
    'rejects a home PAT proposal disabled by a blank project %s',
    async key => {
      fixture.authMode = 'pat';
      fixture.scope = 'home';
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const projectPath = resolveScopedEnvPath('project', fixture.root);
      const original = serializeEnv({ [key]: '' });
      writeFileSync(projectPath, original);
      expect(await fixture.run()).toBe(1);
      expect(existsSync(fixture.target)).toBe(false);
      expect(readFileSync(projectPath, 'utf8')).toBe(original);
    }
  );

  it.each(['app', 'pat'] as const)(
    '%s setup persists the selected allowlist and permits an explicitly empty list',
    async mode => {
      fixture.authMode = mode;
      fixture.allowedUsers = 'Alice,bob';
      expect(await fixture.run()).toBe(0);
      expect(fixture.read().GITHUB_ALLOWED_USERS).toBe('Alice,bob');
      fixture.allowedUsers = '';
      expect(await fixture.run(true)).toBe(0);
      expect(fixture.read().GITHUB_ALLOWED_USERS).toBeUndefined();
    }
  );

  it('App reruns retain an existing allowlist unless forced', async () => {
    fixture.allowedUsers = 'new-user';
    writeFileSync(fixture.target, 'GITHUB_ALLOWED_USERS=existing-user\n');
    expect(await fixture.run()).toBe(0);
    expect(fixture.read().GITHUB_ALLOWED_USERS).toBe('existing-user');
    expect(await fixture.run(true)).toBe(0);
    expect(fixture.read().GITHUB_ALLOWED_USERS).toBe('new-user');
  });

  it('cancelling the App allowlist prompt leaves the env file untouched', async () => {
    fixture.allowedUsers = fixture.cancelled;
    const original = 'CUSTOM_KEY=keep\n';
    writeFileSync(fixture.target, original);
    expect(await fixture.run()).toBe(0);
    expect(readFileSync(fixture.target, 'utf8')).toBe(original);
    expect(fixture.output).toContain('Setup cancelled.');
    expect(
      Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(dirname(fixture.target)))
    ).toEqual([]);
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
      fixture.webhookSecret =
        quote + ['"', "'", '`'].filter(q => q !== quote).join('middle') + 'tail';
      fixture.botDisplayName = 'Bot' + quote;
      if (path !== 'fresh') writeFileSync(fixture.target, 'CUSTOM_KEY=keep\n');
      expect(await fixture.run(path === 'force')).toBe(0);
      const env = fixture.read();
      expect(env.WEBHOOK_SECRET).toBe(fixture.webhookSecret);
      expect(env.BOT_DISPLAY_NAME).toBe(fixture.botDisplayName);
      expect(selectGitHubAuthMode(env)).toEqual({ kind: 'app' });
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      if (path === 'merge') expect(env.CUSTOM_KEY).toBe('keep');
      else expect(env.CUSTOM_KEY).toBeUndefined();
      expect(fixture.output.join('\n')).not.toContain(fixture.webhookSecret);
    }
  );

  it('rejects an unrepresentable complete env document before writing or reporting success', async () => {
    fixture.webhookSecret = '\"single\'back`tick';
    fixture.botDisplayName = '\'name`end"';
    expect(await fixture.run()).toBe(1);
    expect(existsSync(fixture.target)).toBe(false);
    const messages = fixture.output.join('\n');
    expect(messages).toContain('Cannot serialize env without changing its values');
    expect(messages).not.toContain('Configuration written');
    expect(messages).not.toContain(fixture.webhookSecret);
  });

  it('writes an App webhook secret containing every quote delimiter', async () => {
    fixture.webhookSecret = '\"single\'back`tick';
    expect(await fixture.run()).toBe(0);
    expect(fixture.read().WEBHOOK_SECRET).toBe(fixture.webhookSecret);
    expect(selectGitHubAuthMode(fixture.read())).toEqual({ kind: 'app' });
    expect(fixture.output.join('\n')).not.toContain(fixture.webhookSecret);
  });

  it.each(['path', 'inline'] as const)(
    'rejects an EC private key from %s before writing env',
    async source => {
      fixture.keySource = source;
      fixture.keyPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      writeFileSync(fixture.keyPath, fixture.keyPem);
      expect(await fixture.run()).toBe(0);
      expect(fixture.keyValidation).toEqual(['Use an RSA PEM private key']);
      expect(existsSync(fixture.target)).toBe(false);
      expect(fixture.output).toContain('Setup cancelled.');
    }
  );

  it.each(['PAT', 'dual'] as const)(
    'confirms a %s to App switch, backs up and preserves unrelated values',
    async prior => {
      const original =
        `GITHUB_TOKEN=${fixture.pat}\nGH_TOKEN=${fixture.pat}\nWEBHOOK_SECRET=old-webhook\nCUSTOM_KEY=keep\nCUSTOM_PATH='C:\\new folder\\custom'\n` +
        (prior === 'dual'
          ? 'GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=/old.pem\nGITHUB_APP_INSTALLATION_ID=456\n'
          : '');
      writeFileSync(fixture.target, original);
      expect(await fixture.run()).toBe(0);
      expect(fixture.read()).toMatchObject({
        GITHUB_APP_ID: '123',
        CUSTOM_KEY: 'keep',
        CUSTOM_PATH: String.raw`C:\new folder\custom`,
        WEBHOOK_SECRET: fixture.webhookSecret,
      });
      expect(fixture.read().GITHUB_TOKEN).toBeUndefined();
      expect(fixture.read().GH_TOKEN).toBeUndefined();
      expect(fixture.read().GITHUB_APP_INSTALLATION_ID).toBeUndefined();
      expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
        appId: '123',
        privateKey: fixture.privateKey,
      });
      const backups = Array.from(
        new Bun.Glob('.env.archon-backup-*').scanSync(join(fixture.root, '.archon'))
      );
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(fixture.root, '.archon', backups[0]), 'utf8')).toBe(original);
    }
  );

  it.each([false, fixture.cancelled])(
    'leaves the target untouched when switching is declined or cancelled (%s)',
    async answer => {
      fixture.switchAnswer = answer;
      const original = `GITHUB_TOKEN=${fixture.pat}\nCUSTOM_KEY=keep\n`;
      writeFileSync(fixture.target, original);
      expect(await fixture.run()).toBe(0);
      expect(readFileSync(fixture.target, 'utf8')).toBe(original);
      expect(
        Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(fixture.root, '.archon')))
      ).toHaveLength(0);
    }
  );

  it.each([false, true])(
    'same-mode App rerun preserves credentials unless force=%s',
    async force => {
      writeFileSync(
        fixture.target,
        `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${fixture.keyPath}\nWEBHOOK_SECRET=old-webhook\nCUSTOM_KEY=keep\n`
      );
      fixture.switchAnswer = false;
      expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(true);
      expect(await fixture.run(force)).toBe(0);
      expect(fixture.read().GITHUB_APP_ID).toBe(force ? '123' : '999');
      expect(fixture.read().WEBHOOK_SECRET).toBe(force ? fixture.webhookSecret : 'old-webhook');
      if (force) expect(fixture.read().CUSTOM_KEY).toBeUndefined();
      else expect(fixture.read().CUSTOM_KEY).toBe('keep');
    }
  );

  it.each(['path', 'inline'] as const)(
    'same-mode reruns preserve the effective %s key across both proposed sources unless forced',
    async existingSource => {
      const oldKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const oldPath = join(fixture.root, 'old.pem');
      writeFileSync(oldPath, oldKey);
      const original = serializeEnv({
        GITHUB_APP_ID: '999',
        [existingSource === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY']:
          existingSource === 'path' ? oldPath : oldKey,
      });
      for (const proposedSource of ['path', 'inline'] as const) {
        fixture.keySource = proposedSource;
        for (const force of [false, true]) {
          writeFileSync(fixture.target, original);
          expect(await fixture.run(force)).toBe(0);
          expect(loadGitHubAppConfig(fixture.read())?.privateKey).toBe(
            force ? fixture.privateKey : oldKey
          );
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
    fixture.setupMode = 'add';
    const original = serializeEnv({
      [key]: value === 'path' ? '/stale.pem' : value === 'inline' ? fixture.privateKey : value,
      CUSTOM_KEY: 'keep',
    });
    writeFileSync(fixture.target, original);
    expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(false);
    if (['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_PRIVATE_KEY'].includes(key)) {
      fixture.switchAnswer = false;
      expect(await fixture.run()).toBe(0);
      expect(readFileSync(fixture.target, 'utf8')).toBe(original);
      fixture.switchAnswer = true;
    }
    expect(await fixture.run()).toBe(0);
    expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
      appId: '123',
      privateKey: fixture.privateKey,
    });
    expect(fixture.read().GITHUB_APP_PRIVATE_KEY_PATH).toBe(fixture.keyPath);
    expect(fixture.read().GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(fixture.read().CUSTOM_KEY).toBe('keep');
    const backups = Array.from(
      new Bun.Glob('.env.archon-backup-*').scanSync(join(fixture.root, '.archon'))
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture.root, '.archon', backups[0]), 'utf8')).toBe(original);
  });

  it.each(['home', 'project'] as const)(
    'refuses conflicting credentials in the other scope when writing %s',
    async selectedScope => {
      fixture.scope = selectedScope;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const other = resolveScopedEnvPath(
        fixture.scope === 'home' ? 'project' : 'home',
        fixture.root
      );
      for (const [selectedMode, opposite] of [
        ['app', `GITHUB_TOKEN=${fixture.pat}\n`],
        ['app', `GH_TOKEN=${fixture.pat}\n`],
        ['pat', `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${fixture.keyPath}\n`],
      ] as const) {
        fixture.authMode = selectedMode;
        for (const force of [false, true]) {
          writeFileSync(fixture.target, 'CUSTOM_KEY=keep\n');
          writeFileSync(other, opposite);
          expect(await fixture.run(force)).toBe(1);
          expect(readFileSync(fixture.target, 'utf8')).toBe('CUSTOM_KEY=keep\n');
          expect(readFileSync(other, 'utf8')).toBe(opposite);
          expect(fixture.output.join('\n')).toContain(other);
          expect(
            Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(fixture.root, '.archon')))
          ).toHaveLength(0);
          expect(
            Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(fixture.root, 'home')))
          ).toHaveLength(0);
        }
      }
    }
  );
});
