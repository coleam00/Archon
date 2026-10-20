import { TelegramAdapter, GitHubAdapter, DiscordAdapter } from '@archon/adapters';
import { telegramPolicy } from '@archon/adapters/chat/telegram/policy';
import { discordPolicy } from '@archon/adapters/community/chat/discord/policy';
import { GiteaAdapter } from '@archon/adapters/community/forge/gitea';
import { GitLabAdapter } from '@archon/adapters/community/forge/gitlab';
import {
  handleMessage,
  type ConversationLockManager,
  initializeWorkflowGitHubAppAuth,
  isPerUserGitHubEnabled,
  getDecryptedAccessToken,
  type GitHubAuth,
  type IGitHubAppAuthProvider,
} from '@archon/core';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import {
  selectGitHubAuthMode,
  type GitHubAuthModeDecision,
} from '@archon/core/utils/github-auth-mode';
import { resolveGitHubTokenFromEnv } from '@archon/core/github-auth/config';
import { isDiscordMentionRequired } from './discord-mention';
import { resolveUserId, createMessageErrorHandler } from './chat-host/inbound';
import { getLog } from './server-log';

/**
 * The platforms the server delivers to. Both collections are live: `/api/health` and the
 * workflow resume target read them after Telegram, which starts after the HTTP listener.
 */
export interface PlatformRegistry {
  readonly workflowPlatforms: Map<string, IWorkflowPlatform>;
  readonly activePlatforms: string[];
}

export function activatePlatform(
  registry: PlatformRegistry,
  adapter: IWorkflowPlatform,
  label: string
): void {
  registry.workflowPlatforms.set(adapter.getPlatformType(), adapter);
  registry.activePlatforms.push(label);
}

export interface PlatformAdapterContext {
  readonly lockManager: ConversationLockManager;
  readonly botName: string;
  readonly registry: PlatformRegistry;
  /** Chat plugin ids; an installed plugin supersedes the bundled adapter with the same id. */
  readonly installedChatIds: ReadonlySet<string>;
}

export interface PlatformAdapters {
  github: GitHubAdapter | null;
  githubAppAuthProvider: IGitHubAppAuthProvider | null;
  gitea: GiteaAdapter | null;
  gitlab: GitLabAdapter | null;
  discord: DiscordAdapter | null;
}

export const NO_PLATFORM_ADAPTERS: PlatformAdapters = {
  github: null,
  githubAppAuthProvider: null,
  gitea: null,
  gitlab: null,
  discord: null,
};

/** The Gitea settings, or undefined when any of the three is unset. */
export function giteaEnv(
  env: NodeJS.ProcessEnv
): { url: string; token: string; webhookSecret: string } | undefined {
  const { GITEA_URL: url, GITEA_TOKEN: token, GITEA_WEBHOOK_SECRET: webhookSecret } = env;
  return url && token && webhookSecret ? { url, token, webhookSecret } : undefined;
}

/** The GitLab settings, or undefined when the token or webhook secret is unset. */
export function gitlabEnv(
  env: NodeJS.ProcessEnv
): { token: string; webhookSecret: string; url: string | undefined } | undefined {
  const { GITLAB_TOKEN: token, GITLAB_WEBHOOK_SECRET: webhookSecret } = env;
  return token && webhookSecret
    ? { token, webhookSecret, url: env.GITLAB_URL || undefined }
    : undefined;
}

function botMention(mentionEnvVar: string, botName: string): string {
  return process.env[mentionEnvVar] || process.env.BOT_DISPLAY_NAME || botName;
}

/**
 * Starts the forge and Discord adapters the environment configures, in a fixed order:
 * GitHub, Gitea, GitLab, Discord. Telegram starts separately, after the HTTP listener.
 */
export async function startPlatformAdapters(
  ctx: PlatformAdapterContext
): Promise<PlatformAdapters> {
  // GitHub adapter: dual-mode (App vs PAT). Fail fast if both are configured —
  // silently preferring one would create 3am debugging sessions for an operator
  // who copy-pasted half a config and didn't realise the other half was already
  // set in /etc/archon/.env. (PRD: "fail-fast on misconfig".)
  const ghAuthMode = selectGitHubAuthMode(process.env);
  if (ghAuthMode.kind === 'conflict') {
    throw new Error(ghAuthMode.message);
  }
  if (
    !process.env.TELEGRAM_BOT_TOKEN &&
    !process.env.DISCORD_BOT_TOKEN &&
    ghAuthMode.kind === 'none' &&
    !giteaEnv(process.env) &&
    !gitlabEnv(process.env)
  ) {
    getLog().warn('no_platform_adapters_configured');
  }

  const github = await startGitHubAdapter(ghAuthMode, ctx);
  const gitea = await startGiteaAdapter(ctx);
  const gitlab = await startGitLabAdapter(ctx);
  const discord = await startDiscordAdapter(ctx);
  return { ...github, gitea, gitlab, discord };
}

async function startGitHubAdapter(
  mode: Exclude<GitHubAuthModeDecision, { kind: 'conflict' }>,
  ctx: PlatformAdapterContext
): Promise<Pick<PlatformAdapters, 'github' | 'githubAppAuthProvider'>> {
  switch (mode.kind) {
    case 'app':
      return startGitHubAppAdapter(ctx);
    case 'pat':
      return { github: await startGitHubPatAdapter(ctx), githubAppAuthProvider: null };
    case 'none':
      getLog().info('github_adapter_skipped');
      return { github: null, githubAppAuthProvider: null };
  }
}

async function startGitHubAppAdapter(
  ctx: PlatformAdapterContext
): Promise<{ github: GitHubAdapter; githubAppAuthProvider: IGitHubAppAuthProvider }> {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const githubAppAuthProvider = initializeWorkflowGitHubAppAuth();
  if (!githubAppAuthProvider || !webhookSecret) {
    throw new Error('GitHub App mode misconfigured: App credentials and WEBHOOK_SECRET required');
  }
  if (!isPerUserGitHubEnabled()) {
    getLog().warn(
      'github_app.per_user_disabled — set TOKEN_ENCRYPTION_KEY (and GITHUB_APP_CLIENT_ID) to enable per-user GitHub identity'
    );
  }
  const auth: GitHubAuth = { kind: 'app', provider: githubAppAuthProvider };
  // Per-user comment attribution: when enabled, let the adapter author PR/
  // issue comments under the originating user's GitHub identity. Resolver
  // returns undefined for unconnected users → bot identity fallback.
  const getUserToken = isPerUserGitHubEnabled()
    ? async (userId: string): Promise<string | undefined> =>
        (await getDecryptedAccessToken(userId)) ?? undefined
    : undefined;
  const github = new GitHubAdapter(
    auth,
    webhookSecret,
    ctx.lockManager,
    botMention('GITHUB_BOT_MENTION', ctx.botName),
    { getUserToken }
  );
  await github.start();
  activatePlatform(ctx.registry, github, 'GitHub (App)');
  getLog().info({ slug: githubAppAuthProvider.slug }, 'github.adapter_mode_app');
  return { github, githubAppAuthProvider };
}

async function startGitHubPatAdapter(ctx: PlatformAdapterContext): Promise<GitHubAdapter> {
  const patToken = resolveGitHubTokenFromEnv();
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!patToken || !webhookSecret) {
    throw new Error('GitHub PAT mode misconfigured: GITHUB_TOKEN and WEBHOOK_SECRET required');
  }
  const auth: GitHubAuth = { kind: 'pat', token: patToken };
  const github = new GitHubAdapter(
    auth,
    webhookSecret,
    ctx.lockManager,
    botMention('GITHUB_BOT_MENTION', ctx.botName)
  );
  await github.start();
  activatePlatform(ctx.registry, github, 'GitHub');
  getLog().info('github.adapter_mode_pat');
  return github;
}

async function startGiteaAdapter(ctx: PlatformAdapterContext): Promise<GiteaAdapter | null> {
  const env = giteaEnv(process.env);
  if (!env) {
    getLog().info('gitea_adapter_skipped');
    return null;
  }
  const gitea = new GiteaAdapter(
    env.url,
    env.token,
    env.webhookSecret,
    ctx.lockManager,
    botMention('GITEA_BOT_MENTION', ctx.botName)
  );
  await gitea.start();
  activatePlatform(ctx.registry, gitea, 'Gitea');
  return gitea;
}

async function startGitLabAdapter(ctx: PlatformAdapterContext): Promise<GitLabAdapter | null> {
  const env = gitlabEnv(process.env);
  if (!env) {
    getLog().info('gitlab_adapter_skipped');
    return null;
  }
  const gitlab = new GitLabAdapter(
    env.token,
    env.webhookSecret,
    ctx.lockManager,
    env.url,
    botMention('GITLAB_BOT_MENTION', ctx.botName)
  );
  await gitlab.start();
  activatePlatform(ctx.registry, gitlab, 'GitLab');
  return gitlab;
}

async function startDiscordAdapter(ctx: PlatformAdapterContext): Promise<DiscordAdapter | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (ctx.installedChatIds.has(discordPolicy.id) || !token) {
    getLog().info('discord_adapter_skipped');
    return null;
  }
  const streamingMode = (process.env[discordPolicy.streaming.envVar] ??
    discordPolicy.streaming.defaultMode) as 'stream' | 'batch';
  const discord = new DiscordAdapter(token, streamingMode);
  onDiscordMessage(discord, ctx.lockManager);

  // Don't let a Discord login failure (bad token, missing privileged
  // intents, etc.) bring down the whole server — users running
  // `archon serve` for the web UI shouldn't lose it because of an
  // unrelated bot misconfiguration. See #1365.
  try {
    await discord.start();
    activatePlatform(ctx.registry, discord, 'Discord');
    return discord;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, hint: discordStartHint(err) },
      'discord.start_failed_continuing_without_adapter'
    );
    return null;
  }
}

function discordStartHint(err: Error): string {
  if (err.message?.includes('disallowed intents')) {
    return (
      'Enable "Message Content Intent" in the Discord Developer Portal ' +
      '(your application > Bot > Privileged Gateway Intents) and restart, ' +
      'or unset DISCORD_BOT_TOKEN if you do not want the Discord adapter.'
    );
  }
  return 'Verify DISCORD_BOT_TOKEN is valid, or unset it to disable the Discord adapter.';
}

function onDiscordMessage(discord: DiscordAdapter, lockManager: ConversationLockManager): void {
  const requireMention = isDiscordMentionRequired();
  discord.onMessage(async ({ message, platformUserId, displayName }) => {
    // Get initial conversation ID
    let conversationId = discord.getConversationId(message);

    // Skip if no content
    if (!message.content) return;

    // Check if bot was mentioned (required for activation unless
    // DISCORD_REQUIRE_MENTION=false opts out of the gate)
    // Exception: DMs never require mention
    const isDM = !message.guild;
    if (!isDM && requireMention && !discord.isBotMentioned(message)) {
      return; // Ignore messages that don't mention the bot
    }

    // Strip the bot mention from the message
    const content = discord.stripBotMention(message);
    if (!content) return; // Message was only a mention with no content

    // Ensure we're responding in a thread - creates one if needed
    conversationId = await discord.ensureThread(conversationId, message);

    // Check for thread context (now we're guaranteed to be in a thread if applicable)
    let threadContext: string | undefined;
    let parentConversationId: string | undefined;

    if (discord.isThread(message)) {
      // Fetch thread history for context (exclude current message)
      const history = await discord.fetchThreadHistory(message);
      if (history.length > 1) {
        threadContext = history.slice(0, -1).join('\n');
      }

      // Get parent channel ID for context inheritance
      parentConversationId = discord.getParentChannelId(message) ?? undefined;
    }

    // Resolve Discord author → Archon user UUID.
    // displayName is already display-quality on Discord (no extra API call needed).
    const userId = await resolveUserId('discord', platformUserId, displayName);

    // Fire-and-forget: handler returns immediately, processing happens async
    lockManager
      .acquireLock(conversationId, async () => {
        await handleMessage(discord, conversationId, content, {
          threadContext,
          parentConversationId,
          isolationHints: { workflowType: 'thread', workflowId: conversationId },
          actor: userId ? { kind: 'user', userId } : { kind: 'unidentified' },
        });
      })
      .catch(createMessageErrorHandler('Discord', discord, conversationId));
  });
}

/**
 * Starts Telegram unless a chat plugin supersedes it or no token is set. A failed
 * `start()` is logged and returns null; construction errors propagate.
 */
export async function startTelegramAdapter(
  ctx: PlatformAdapterContext
): Promise<TelegramAdapter | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (ctx.installedChatIds.has(telegramPolicy.id) || !token) {
    getLog().info('telegram_adapter_skipped');
    return null;
  }
  const streamingMode = (process.env[telegramPolicy.streaming.envVar] ??
    telegramPolicy.streaming.defaultMode) as 'stream' | 'batch';
  const telegram = new TelegramAdapter(token, streamingMode);
  const { lockManager } = ctx;

  // Register message handler (auth is handled internally by adapter)
  telegram.onMessage(async ({ conversationId, message, userId: telegramUserId, displayName }) => {
    // Resolve Telegram user id (numeric) → Archon user UUID.
    const userId = await resolveUserId('telegram', telegramUserId, displayName);

    // Fire-and-forget: handler returns immediately, processing happens async
    lockManager
      .acquireLock(conversationId, async () => {
        await handleMessage(telegram, conversationId, message, {
          isolationHints: { workflowType: 'thread', workflowId: conversationId },
          actor: userId ? { kind: 'user', userId } : { kind: 'unidentified' },
        });
      })
      .catch(createMessageErrorHandler('Telegram', telegram, conversationId));
  });

  try {
    await telegram.start();
    activatePlatform(ctx.registry, telegram, 'Telegram');
    return telegram;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    getLog().error({ err: error, errorType: error.constructor.name }, 'telegram.start_failed');
    return null; // Don't include in active platforms or shutdown
  }
}
