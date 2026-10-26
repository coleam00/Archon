import { beforeEach, afterEach, spyOn } from 'bun:test';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateKeyPairSync } from 'node:crypto';
import * as git from '@archon/git';
import { setupCommand } from './setup';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';
import { parse as parseDotenv } from 'dotenv';

export class GitHubSetupFixture {
  privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  pat = 'ghp_fixture_token';
  appId!: string;
  appSlug!: string;
  inputValidation!: (string | Error | undefined)[];
  webhookSecret!: string;
  botDisplayName!: string;
  keyPem!: string;
  keyValidation!: (string | Error | undefined)[];
  root!: string;
  target!: string;
  keyPath!: string;
  allowedUsers!: string | symbol;
  savedHome!: string | undefined;
  authMode!: 'app' | 'pat';
  keySource!: 'path' | 'inline';
  switchAnswer!: boolean | symbol;
  setupMode!: 'update' | 'add' | 'fresh';
  scope!: 'home' | 'project';
  output!: string[];
  restore!: (() => void)[];
  initialAuthMode!: unknown;
  passwordMessages!: string[];
  cancelled = Symbol('cancelled');
  nativeIsCancel = prompts.isCancel;
  run = (force = false) =>
    setupCommand({ repoPath: this.root, scope: this.scope, providers: [], force });
  read = () => parseDotenv(readFileSync(this.target, 'utf8'));

  constructor() {
    beforeEach(() => {
      this.root = mkdtempSync(join(tmpdir(), 'archon-setup-github-'));
      this.savedHome = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = join(this.root, 'home');
      mkdirSync(join(this.root, 'home'));
      mkdirSync(join(this.root, '.archon'));
      this.target = join(this.root, '.archon', '.env');
      this.appId = '123';
      this.appSlug = 'fixture-app';
      this.inputValidation = [];
      this.webhookSecret = 'fixture-webhook-secret';
      this.botDisplayName = 'Archon';
      this.keyPem = this.privateKey;
      this.keyValidation = [];
      this.allowedUsers = '';
      this.keyPath = join(this.root, 'app.pem');
      writeFileSync(this.keyPath, this.privateKey);
      this.authMode = 'app';
      this.keySource = 'path';
      this.switchAnswer = true;
      this.setupMode = 'update';
      this.scope = 'project';
      this.output = [];
      this.initialAuthMode = undefined;
      this.passwordMessages = [];
      const cancellation = spyOn(prompts, 'isCancel').mockImplementation(
        (value): value is symbol => value === this.cancelled || this.nativeIsCancel(value)
      );
      const selection = spyOn(prompts, 'select').mockImplementation(async options => {
        if (options.message === 'GitHub authentication mode?')
          this.initialAuthMode = options.initialValue;
        const wanted =
          options.message === 'What would you like to do?'
            ? this.setupMode
            : options.message === 'GitHub authentication mode?'
              ? this.authMode
              : options.message === 'GitHub App private key source?'
                ? this.keySource
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
        if (options.message === 'Enter the bot display name:') return this.botDisplayName;
        if (options.message === 'GitHub App ID:') {
          const error = await options.validate?.(this.appId);
          this.inputValidation.push(error);
          return error ? this.cancelled : this.appId;
        }
        if (
          options.message ===
          'Enter allowed GitHub usernames (comma-separated, or leave empty for all):'
        )
          return this.allowedUsers;
        if (options.message === 'GitHub App private key path:') {
          const error = await options.validate?.(this.keyPath);
          this.keyValidation.push(error);
          return error ? this.cancelled : this.keyPath;
        }
        if (options.message === 'GitHub App slug (optional):') return this.appSlug;
        return '';
      });
      const secret = spyOn(prompts, 'password').mockImplementation(async options => {
        this.passwordMessages.push(options.message);
        if (options.message === 'Enter your Telegram Bot Token:') return '123456:new-telegram';
        if (options.message === 'Enter your Slack Bot Token (xoxb-...):') return 'xoxb-new-slack';
        if (options.message === 'Enter your Slack App Token (xapp-...):') return 'xapp-new-slack';
        if (options.message === 'GitHub App private key (PEM):') {
          const value = this.keyPem.replace(/\n/g, '\\n');
          const error = await options.validate?.(value);
          this.keyValidation.push(error);
          return error ? this.cancelled : value;
        }
        if (options.message === 'GitHub webhook secret:') {
          const error = await options.validate?.(this.webhookSecret);
          this.inputValidation.push(error);
          return error ? this.cancelled : this.webhookSecret;
        }
        if (options.message === 'Enter your GitHub Personal Access Token:') return this.pat;
        throw new Error(`Unexpected password: ${options.message}`);
      });
      const confirmation = spyOn(prompts, 'confirm').mockImplementation(async options =>
        options.message.startsWith('Replace existing GitHub authentication')
          ? this.switchAnswer
          : options.message === 'Do you want to set a custom bot display name? (Default: Archon)' &&
            this.botDisplayName !== 'Archon'
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue(['github']);
      const notes = spyOn(prompts, 'note').mockImplementation(message => {
        this.output.push(message ?? '');
      });
      const info = spyOn(prompts.log, 'info').mockImplementation(message => {
        this.output.push(message);
      });
      const success = spyOn(prompts.log, 'success').mockImplementation(message => {
        this.output.push(message);
      });
      const cancellationOutput = spyOn(prompts, 'cancel').mockImplementation(message => {
        this.output.push(message ?? '');
      });
      const gh = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
      this.restore = [
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
      for (const undo of this.restore) undo();
      if (this.savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = this.savedHome;
      await removeTempTree(this.root);
    });
  }
}
