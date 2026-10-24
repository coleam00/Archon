import { describe, it, expect, spyOn } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

import {
  GITHUB_APP_CREDENTIAL_KEYS,
  selectGitHubAuthMode,
} from '@archon/core/utils/github-auth-mode';
import { loadGitHubAppConfig } from '@archon/core/github-auth/config';
import { setupCommand } from './setup';

import { serializeEnv, resolveScopedEnvPath } from './setup-env';
import * as prompts from '@clack/prompts';

import { parse as parseDotenv } from 'dotenv';
import { GitHubSetupFixture } from './setup-github-fixture';

describe('GitHub setup wizard', () => {
  const fixture = new GitHubSetupFixture();
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
      fixture.setupMode = scenario.mode;
      fixture.scope = scenario.selectedScope;
      fixture.keySource = scenario.source;
      fixture.appSlug = '';
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const otherPath = resolveScopedEnvPath(
        fixture.scope === 'home' ? 'project' : 'home',
        fixture.root
      );
      const blankPath = scenario.placement === 'selected' ? fixture.target : otherPath;
      const original = serializeEnv({ [scenario.key]: scenario.blank, CUSTOM_KEY: 'keep' });
      writeFileSync(blankPath, original);
      const result = await fixture.run(scenario.force);
      const blocked = scenario.placement === 'other';
      expect(result).toBe(blocked ? 1 : 0);
      if (blocked) {
        expect(readFileSync(otherPath, 'utf8')).toBe(original);
        expect(existsSync(fixture.target)).toBe(false);
      } else {
        const homePath = resolveScopedEnvPath('home', fixture.root);
        const home = existsSync(homePath) ? parseDotenv(readFileSync(homePath, 'utf8')) : {};
        const projectPath = resolveScopedEnvPath('project', fixture.root);
        const project = existsSync(projectPath)
          ? parseDotenv(readFileSync(projectPath, 'utf8'))
          : {};
        expect(loadGitHubAppConfig({ ...home, ...project })).toMatchObject({
          appId: '123',
          privateKey: fixture.privateKey,
          slug: 'archon',
        });
        if (!scenario.force) expect(fixture.read().CUSTOM_KEY).toBe('keep');
      }
    }
  );

  it.each(['GITHUB_APP_SLUG', 'GITHUB_APP_INSTALLATION_ID'])(
    'Add removes selected blank %s even when GitHub collection is skipped',
    async key => {
      fixture.setupMode = 'add';
      writeFileSync(
        fixture.target,
        serializeEnv({
          GITHUB_APP_ID: '123',
          GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath,
          WEBHOOK_SECRET: fixture.webhookSecret,
          [key]: '   ',
        })
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await fixture.run()).toBe(0);
        expect(loadGitHubAppConfig(fixture.read())).toMatchObject({
          appId: '123',
          slug: 'archon',
          privateKey: fixture.privateKey,
        });
        expect(fixture.read()[key]).toBeUndefined();
      } finally {
        platforms.mockRestore();
      }
    }
  );

  it.each(['GITHUB_APP_SLUG', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH'])(
    'project App proposal safely overrides a home blank %s',
    async key => {
      writeFileSync(resolveScopedEnvPath('home', fixture.root), serializeEnv({ [key]: '   ' }));
      expect(await fixture.run()).toBe(0);
      const home = parseDotenv(readFileSync(resolveScopedEnvPath('home', fixture.root), 'utf8'));
      expect(loadGitHubAppConfig({ ...home, ...fixture.read() })).toMatchObject({
        appId: '123',
        slug: 'fixture-app',
        privateKey: fixture.privateKey,
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
      fixture.setupMode = scenario.mode;
      fixture.scope = scenario.selectedScope;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const otherPath = resolveScopedEnvPath(
        fixture.scope === 'home' ? 'project' : 'home',
        fixture.root
      );
      const original = serializeEnv({
        GITHUB_APP_ID: '123',
        [scenario.source === 'path' ? 'GITHUB_APP_PRIVATE_KEY_PATH' : 'GITHUB_APP_PRIVATE_KEY']:
          scenario.source === 'path' ? fixture.keyPath : fixture.privateKey,
        WEBHOOK_SECRET: fixture.webhookSecret,
      });
      writeFileSync(fixture.target, original);
      writeFileSync(otherPath, serializeEnv({ [scenario.key]: '' }));
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(await fixture.run()).toBe(1);
        expect(readFileSync(fixture.target, 'utf8')).toBe(original);
        expect(readdirSync(dirname(fixture.target))).toEqual(['.env']);
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
      fixture.scope = 'home';
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      fixture.keySource = scenario.source;
      const otherPath = resolveScopedEnvPath('project', fixture.root);
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
      expect(await fixture.run()).toBe(1);
      expect(existsSync(fixture.target)).toBe(false);
      expect(readFileSync(otherPath, 'utf8')).toBe(original);
    }
  );

  it('rejects a retained home App disabled by empty project activation fields', async () => {
    fixture.scope = 'home';
    fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
    writeFileSync(
      fixture.target,
      serializeEnv({
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY_PATH: fixture.keyPath,
        WEBHOOK_SECRET: fixture.webhookSecret,
      })
    );
    writeFileSync(
      resolveScopedEnvPath('project', fixture.root),
      serializeEnv({
        GITHUB_APP_ID: '',
        GITHUB_APP_PRIVATE_KEY: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
      })
    );
    const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
    try {
      expect(await fixture.run()).toBe(1);
      expect(readdirSync(dirname(fixture.target))).toEqual(['.env']);
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
      fixture.scope = scenario.selectedScope;
      fixture.setupMode = scenario.mode;
      fixture.target = resolveScopedEnvPath(fixture.scope, fixture.root);
      const credential = {
        [scenario.key]:
          scenario.key === 'GITHUB_APP_PRIVATE_KEY'
            ? fixture.privateKey
            : scenario.key === 'GITHUB_APP_PRIVATE_KEY_PATH'
              ? fixture.keyPath
              : '123',
      };
      const inheritedEnv = scenario.layer === 'inherited' ? credential : {};
      const home =
        scenario.layer === 'home-complete'
          ? {
              GITHUB_APP_ID: '123',
              GITHUB_APP_PRIVATE_KEY: fixture.privateKey,
              WEBHOOK_SECRET: fixture.webhookSecret,
              ...credential,
            }
          : scenario.layer === 'home-partial'
            ? credential
            : {};
      const savedPat = {
        GITHUB_TOKEN: fixture.pat,
        WEBHOOK_SECRET: fixture.webhookSecret,
        GITHUB_APP_ID: '',
        GITHUB_APP_PRIVATE_KEY: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
        CUSTOM_KEY: 'keep',
      };
      const homePath = resolveScopedEnvPath('home', fixture.root);
      const projectPath = resolveScopedEnvPath('project', fixture.root);
      writeFileSync(
        homePath,
        serializeEnv(scenario.layer === 'inherited' && fixture.scope === 'home' ? savedPat : home)
      );
      writeFileSync(projectPath, serializeEnv(savedPat));
      const original = readFileSync(fixture.target, 'utf8');
      const otherPath = fixture.scope === 'home' ? projectPath : homePath;
      const otherOriginal = readFileSync(otherPath, 'utf8');
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      try {
        expect(
          await setupCommand({
            repoPath: fixture.root,
            scope: fixture.scope,
            providers: [],
            inheritedEnv,
          })
        ).toBe(0);
        const effective = {
          ...inheritedEnv,
          ...parseDotenv(readFileSync(homePath, 'utf8')),
          ...parseDotenv(readFileSync(projectPath, 'utf8')),
        };
        expect(selectGitHubAuthMode(effective)).toEqual({ kind: 'pat' });
        expect(loadGitHubAppConfig(effective)).toBeNull();
        expect(effective.GITHUB_TOKEN).toBe(fixture.pat);
        expect(effective.CUSTOM_KEY).toBe('keep');
        expect(readFileSync(otherPath, 'utf8')).toBe(otherOriginal);
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

  it.each([false, true])(
    'previews a PAT switch from the startup environment (inherited PAT=%j)',
    async inheritedPat => {
      const original = serializeEnv({
        GITHUB_TOKEN: fixture.pat,
        WEBHOOK_SECRET: fixture.webhookSecret,
      });
      writeFileSync(fixture.target, original);
      const prior = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = fixture.pat;
      try {
        const inheritedEnv = inheritedPat ? { GITHUB_TOKEN: fixture.pat } : {};
        expect(
          await setupCommand({
            repoPath: fixture.root,
            scope: fixture.scope,
            providers: [],
            inheritedEnv,
          })
        ).toBe(inheritedPat ? 1 : 0);
        if (inheritedPat) {
          expect(readFileSync(fixture.target, 'utf8')).toBe(original);
          expect(readdirSync(dirname(fixture.target))).toEqual(['.env']);
        } else {
          const effective = { ...inheritedEnv, ...fixture.read() };
          expect(selectGitHubAuthMode(effective)).toEqual({ kind: 'app' });
          expect(loadGitHubAppConfig(effective)).toMatchObject({
            appId: '123',
            privateKey: fixture.privateKey,
          });
        }
      } finally {
        if (prior === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = prior;
      }
    }
  );

  it('rejects inherited PAT beside a proposed App before writing', async () => {
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = fixture.pat;
    try {
      expect(await fixture.run()).toBe(1);
      expect(existsSync(fixture.target)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prior;
    }
  });
});
