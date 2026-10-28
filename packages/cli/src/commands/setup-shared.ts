/**
 * Types and early-exit helpers shared by the setup wizard modules.
 */
import { cancel } from '@clack/prompts';
import { createLogger } from '@archon/paths';
import type { PlatformSelection } from './setup-platform-selection';

let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.setup');
  return cachedLog;
}

export interface SetupConfig {
  ai: {
    claude: boolean;
    claudeAuthType?: 'global' | 'apiKey' | 'oauthToken';
    claudeApiKey?: string;
    claudeOauthToken?: string;
    /** Absolute path to Claude Code SDK's cli.js. Written as CLAUDE_BIN_PATH
     *  in ~/.archon/.env. Required in compiled Archon binaries; harmless in dev. */
    claudeBinaryPath?: string;
    codex: boolean;
    codexTokens?: CodexTokens;
    pi: boolean;
    /** e.g. 'anthropic/claude-haiku-4-5' — written to ~/.archon/config.yaml */
    piModel?: string;
    /** API key value for the chosen Pi backend */
    piApiKey?: string;
    /** Canonical env var name for the chosen Pi backend, e.g. 'ANTHROPIC_API_KEY' */
    piApiKeyEnvVar?: string;
    defaultAssistant: string | undefined;
    /** Gates the config.yaml write so an empty selection preserves the saved default. */
    defaultAssistantSelected?: boolean;
    /** Default CHAT model for the default assistant — written to
     *  ~/.archon/config.yaml as `assistants.<defaultAssistant>.model` (#1999).
     *  Unset when the user keeps the SDK default (or the default is Pi, whose
     *  model is collected in collectPiConfig). */
    defaultModel?: string;
  };
  platforms: PlatformSelection;
  github?: GitHubConfig;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  botDisplayName: string;
}

export type GitHubConfig = {
  webhookSecret: string;
  allowedUsers: string;
  botMention?: string;
} & (
  | { mode: 'pat'; token: string }
  | {
      mode: 'app';
      appId: string;
      slug?: string;
      privateKey: { source: 'path' | 'inline'; value: string };
    }
);

export interface TelegramConfig {
  botToken: string;
  allowedUserIds: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string;
}

export interface CodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

export interface SetupOptions {
  /** Environment before CLI startup overlays the Archon env files. */
  inheritedEnv?: NodeJS.ProcessEnv;
  spawn?: boolean;
  providers?: readonly string[];
  repoPath: string;
  /** Which archon-owned file to target. Default: 'home'. */
  scope?: 'home' | 'project';
  /** Skip merge and overwrite the target wholesale (backup still written). Default: false. */
  force?: boolean;
}

/**
 * Ends setup early. Thrown instead of calling `process.exit` so the CLI's
 * `main()` returns the code through its `finally`, which flushes telemetry.
 */
export class SetupExit extends Error {
  constructor(readonly exitCode: 0 | 1) {
    super(`setup exited with ${exitCode}`);
  }
}

export function exitSetup(exitCode: 0 | 1): never {
  throw new SetupExit(exitCode);
}

export function cancelSetup(): never {
  cancel('Setup cancelled.');
  exitSetup(0);
}
