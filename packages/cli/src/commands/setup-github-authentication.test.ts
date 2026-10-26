import { describe, it, expect, spyOn } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

import { selectGitHubAuthMode } from '@archon/core/utils/github-auth-mode';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';

import {
  GITHUB_APP_KEYS,
  checkExistingConfig,
  generateEnvContent,
  serializeEnv,
  resolveScopedEnvPath,
} from './setup-env';
import * as prompts from '@clack/prompts';

import { parse as parseDotenv } from 'dotenv';
import { GitHubSetupFixture } from './setup-github-fixture';

describe('GitHub setup wizard', () => {
  const fixture = new GitHubSetupFixture();
  it.each(['app', 'pat'] as const)(
    'Add completes %s authentication missing its webhook',
    async selectedMode => {
      fixture.setupMode = 'add';
      fixture.authMode = selectedMode;
      writeFileSync(
        fixture.target,
        serializeEnv(
          selectedMode === 'app'
            ? { GITHUB_APP_ID: '999', GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath }
            : { GITHUB_TOKEN: 'old-token' }
        )
      );
      expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(false);
      expect(await fixture.run()).toBe(0);
      expect(selectGitHubAuthMode(fixture.read())).toEqual({ kind: selectedMode });
      if (selectedMode === 'app')
        expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
          appId: '999',
          privateKey: fixture.privateKey,
        });
      else expect(fixture.read().GITHUB_TOKEN).toBe('old-token');
    }
  );

  it.each(['app', 'pat'] as const)(
    'Add resolves dual authentication after confirmation into %s',
    async selectedMode => {
      fixture.setupMode = 'add';
      fixture.authMode = selectedMode;
      const original = serializeEnv({
        GITHUB_APP_ID: '999',
        GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath,
        GITHUB_TOKEN: fixture.pat,
        WEBHOOK_SECRET: 'old-webhook',
        CUSTOM_KEY: 'keep',
      });
      writeFileSync(fixture.target, original);
      expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(false);
      fixture.switchAnswer = false;
      expect(await fixture.run()).toBe(0);
      expect(readFileSync(fixture.target, 'utf8')).toBe(original);
      expect(prompts.confirm).toHaveBeenCalledWith({
        message: `Replace existing GitHub authentication with ${selectedMode === 'app' ? 'GitHub App' : 'personal access token'} mode? A backup will be saved.`,
        initialValue: false,
      });
      fixture.switchAnswer = true;
      expect(await fixture.run()).toBe(0);
      expect(selectGitHubAuthMode(fixture.read())).toEqual({ kind: selectedMode });
      expect(fixture.read().CUSTOM_KEY).toBe('keep');
      if (selectedMode === 'app')
        expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
          appId: '123',
          privateKey: fixture.privateKey,
        });
    }
  );

  it('refuses unresolved selected-file dual mode even when GitHub is not selected in Add', async () => {
    fixture.setupMode = 'add';
    const original = serializeEnv({
      GITHUB_APP_ID: '999',
      GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath,
      GITHUB_TOKEN: fixture.pat,
      WEBHOOK_SECRET: fixture.webhookSecret,
    });
    writeFileSync(fixture.target, original);
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    try {
      expect(await fixture.run()).toBe(1);
      expect(readFileSync(fixture.target, 'utf8')).toBe(original);
      expect(
        Array.from(new Bun.Glob('.env.archon-backup-*').scanSync(join(fixture.root, '.archon')))
      ).toHaveLength(0);
    } finally {
      platforms.mockRestore();
    }
  });

  it.each(['home', 'project'] as const)(
    'force clears selected-file dual mode without selecting GitHub in %s',
    async selectedScope => {
      fixture.scope = selectedScope;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        for (const mode of ['fresh', 'add', 'update'] as const) {
          fixture.setupMode = mode;
          for (const source of ['path', 'inline'] as const) {
            const original = serializeEnv({
              GITHUB_APP_ID: '999',
              [source === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY']:
                source === 'path' ? fixture.keyPath : fixture.privateKey,
              GITHUB_TOKEN: fixture.pat,
              WEBHOOK_SECRET: fixture.webhookSecret,
              CUSTOM_KEY: `${mode}-${source}`,
            });
            writeFileSync(fixture.target, original);
            expect(await fixture.run(true)).toBe(0);
            expect(selectGitHubAuthMode(fixture.read())).toEqual({ kind: 'none' });
            for (const key of [...GITHUB_APP_KEYS, 'GH_TOKEN', 'GITHUB_TOKEN'])
              expect(fixture.read()[key]).toBeUndefined();
            const backups = Array.from(
              new Bun.Glob('.env.archon-backup-*').scanSync(dirname(fixture.target))
            );
            expect(backups.length).toBeGreaterThan(0);
            expect(
              backups.some(
                file => readFileSync(join(dirname(fixture.target), file), 'utf8') === original
              )
            ).toBe(true);
          }
        }
      } finally {
        platforms.mockRestore();
      }
    }
  );

  async function collectBlankAuthentication(key: string, whitespace: string) {
    const inline = key === 'GITHUB_APP_PRIVATE_KEY';
    const credentials: Record<string, string> =
      fixture.authMode === 'pat'
        ? { GITHUB_TOKEN: fixture.pat }
        : {
            GITHUB_APP_ID: '999',
            [inline ? key : 'GITHUB_APP_PRIVATE_KEY_PATH']: inline
              ? fixture.privateKey
              : fixture.keyPath,
          };
    const original = serializeEnv({
      ...credentials,
      WEBHOOK_SECRET: fixture.webhookSecret,
      CUSTOM_KEY: 'keep',
      [key]: whitespace,
    });
    writeFileSync(fixture.target, original);
    expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(false);
    fixture.initialAuthMode = undefined;
    expect(await fixture.run()).toBe(0);
    expect(fixture.initialAuthMode).toBe('pat');
    expect(selectGitHubAuthMode(fixture.read())).toEqual({ kind: fixture.authMode });
    expect(fixture.read().CUSTOM_KEY).toBe('keep');
    if (fixture.authMode === 'app')
      expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
        appId: '123',
        privateKey: fixture.privateKey,
      });
    else expect(fixture.read().GITHUB_TOKEN).toBe(fixture.pat);
  }

  it.each(['home', 'project'] as const)(
    'Add collects credentials for each blank authentication field in %s',
    async selectedScope => {
      fixture.scope = selectedScope;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      fixture.setupMode = 'add';
      for (const key of [
        'GITHUB_TOKEN',
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_APP_PRIVATE_KEY_PATH',
      ]) {
        fixture.authMode = key === 'GITHUB_TOKEN' ? 'pat' : 'app';
        for (const whitespace of [' ', '   ', '\t']) {
          await collectBlankAuthentication(key, whitespace);
        }
      }
    }
  );

  it('Add resolves a raw conflict even when the PAT is blank', async () => {
    fixture.setupMode = 'add';
    writeFileSync(
      fixture.target,
      serializeEnv({
        GITHUB_APP_ID: '999',
        GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath,
        GITHUB_TOKEN: '   ',
        WEBHOOK_SECRET: fixture.webhookSecret,
      })
    );
    expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(false);
    expect(await fixture.run()).toBe(0);
    expect(fixture.read().GITHUB_TOKEN).toBeUndefined();
    expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
      appId: '123',
      privateKey: fixture.privateKey,
    });
  });

  it.each(['path', 'inline'] as const)(
    'Add retains a usable %s key when the alternate source is blank',
    async source => {
      fixture.setupMode = 'add';
      writeFileSync(
        fixture.target,
        serializeEnv({
          GITHUB_APP_ID: '999',
          GITHUB_APP_PRIVATE_KEY: source === 'inline' ? fixture.privateKey : '   ',
          GITHUB_APP_PRIVATE_KEY_PATH: source === 'path' ? fixture.keyPath : '   ',
          WEBHOOK_SECRET: fixture.webhookSecret,
        })
      );
      expect(checkExistingConfig(fixture.target)?.platforms.github).toBe(true);
      expect(await fixture.run()).toBe(0);
      expect(fixture.initialAuthMode).toBeUndefined();
      expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
        appId: '999',
        privateKey: fixture.privateKey,
      });
    }
  );

  it.each(['home', 'project'] as const)(
    'refuses runtime-active whitespace in the other scope from %s',
    async selectedScope => {
      fixture.scope = selectedScope;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const other = resolveScopedEnvPath(
        fixture.scope === 'home' ? 'project' : 'home',
        fixture.root
      );
      for (const key of [
        'GITHUB_TOKEN',
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY',
        'GITHUB_APP_PRIVATE_KEY_PATH',
      ]) {
        fixture.authMode = key === 'GITHUB_TOKEN' ? 'app' : 'pat';
        for (const whitespace of [' ', '   ', '\t']) {
          for (const force of [false, true]) {
            const original = serializeEnv({ [key]: whitespace });
            writeFileSync(other, original);
            writeFileSync(fixture.target, 'CUSTOM_KEY=keep\n');
            expect(await fixture.run(force)).toBe(1);
            expect(readFileSync(other, 'utf8')).toBe(original);
            expect(readFileSync(fixture.target, 'utf8')).toBe('CUSTOM_KEY=keep\n');
            for (const dir of [join(fixture.root, 'home'), join(fixture.root, '.archon')])
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
      options.message === 'GitHub webhook secret:' ? value : fixture.pat
    );
    try {
      expect(await fixture.run()).toBe(0);
      expect(fixture.read().WEBHOOK_SECRET).toBe(value);
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
            ? { mode: 'pat', token: fixture.pat, webhookSecret: value, allowedUsers: '' }
            : {
                mode: 'app',
                appId: '123',
                privateKey: { source: 'path', value: fixture.keyPath },
                webhookSecret: value,
                allowedUsers: '',
              },
        botDisplayName: 'Archon',
      });
      expect(parseDotenv(content).WEBHOOK_SECRET).toBe(value);
    }
  );

  it('Add still checks the other scope when retaining existing App credentials', async () => {
    fixture.setupMode = 'add';
    const original = `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${fixture.keyPath}\n`;
    writeFileSync(fixture.target, original);
    const other = join(fixture.root, 'home', '.env');
    writeFileSync(other, `GITHUB_TOKEN=${fixture.pat}\n`);
    expect(await fixture.run()).toBe(1);
    expect(readFileSync(fixture.target, 'utf8')).toBe(original);
    expect(fixture.output.join('\n')).toContain(other);
  });

  it('add mode recognizes and retains existing App configuration', async () => {
    fixture.setupMode = 'add';
    writeFileSync(
      fixture.target,
      `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${fixture.keyPath}\nWEBHOOK_SECRET=old-webhook\n`
    );
    expect(await fixture.run()).toBe(0);
    expect(fixture.read().GITHUB_APP_ID).toBe('999');
    expect(fixture.read().GITHUB_TOKEN).toBeUndefined();
  });

  it('same-mode PAT reruns keep non-empty credentials and webhook settings', async () => {
    fixture.authMode = 'pat';
    fixture.switchAnswer = false;
    writeFileSync(
      fixture.target,
      'GITHUB_TOKEN=existing-token\nGH_TOKEN=existing-token\nWEBHOOK_SECRET=existing-secret\n'
    );
    expect(await fixture.run()).toBe(0);
    expect(fixture.read()).toMatchObject({
      GITHUB_TOKEN: 'existing-token',
      GH_TOKEN: 'existing-token',
      WEBHOOK_SECRET: 'existing-secret',
    });
  });

  it('an inline App key survives a same-mode merge and remains usable', async () => {
    fixture.keySource = 'inline';
    expect(await fixture.run()).toBe(0);
    expect(await fixture.run()).toBe(0);
    expect(loadGitHubAppConfig(fixture.read())).toMatchObject({ privateKey: fixture.privateKey });
  });

  it('PAT remains the default and a confirmed App to PAT switch removes App auth keys', async () => {
    fixture.authMode = 'pat';
    writeFileSync(
      fixture.target,
      `GITHUB_APP_ID=999\nGITHUB_APP_PRIVATE_KEY_PATH=${fixture.keyPath}\nGITHUB_APP_SLUG=old-app\nGITHUB_APP_INSTALLATION_ID=456\nGITHUB_APP_CLIENT_ID=Iv1.old\nTOKEN_ENCRYPTION_KEY=keep-encryption\nWEBHOOK_SECRET=keep-webhook\nCUSTOM_KEY=keep\n`
    );
    expect(await fixture.run()).toBe(0);
    expect(fixture.read()).toMatchObject({
      GITHUB_TOKEN: fixture.pat,
      GH_TOKEN: fixture.pat,
      CUSTOM_KEY: 'keep',
    });
    expect(fixture.read().GITHUB_APP_ID).toBeUndefined();
    expect(fixture.read().GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined();
    expect(fixture.read().GITHUB_APP_SLUG).toBeUndefined();
    expect(fixture.read().GITHUB_APP_INSTALLATION_ID).toBeUndefined();
    expect(fixture.read().GITHUB_APP_CLIENT_ID).toBeUndefined();
    expect(fixture.read().TOKEN_ENCRYPTION_KEY).toBe('keep-encryption');
    expect(fixture.read().WEBHOOK_SECRET).toBe('keep-webhook');
    expect(fixture.initialAuthMode).toBe('pat');
    expect(fixture.output.join('\n')).not.toContain(fixture.pat);
    expect(fixture.output.join('\n')).not.toContain(fixture.read().WEBHOOK_SECRET);
  });
});
