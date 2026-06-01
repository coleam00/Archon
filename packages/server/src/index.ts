/**
 * Remote Coding Agent - Main Entry Point
 * Multi-platform AI coding assistant (Telegram, Discord, Slack, GitHub, Gitea)
 */

// Strip CWD .env keys FIRST — before any application imports read process.env.
// Bun auto-loads .env/.env.local/.env.development/.env.production from CWD;
// when `bun run dev:server` is run from inside a target repo those keys leak
// into the server process. stripCwdEnv() removes them before ~/.archon/.env loads.
import '@archon/paths/strip-cwd-env-boot';

// Load environment variables — after CWD stripping, before application imports.
import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { BUNDLED_IS_BINARY, getArchonEnvPath } from '@archon/paths';

// In dev/source mode, load the repo root .env (platform tokens, API keys, etc.)
// import.meta.dir is frozen at build time, so skip in compiled binaries.
const envPath = BUNDLED_IS_BINARY ? undefined : resolve(import.meta.dir, '..', '..', '..', '.env');

if (envPath) {
  const dotenvResult = config({ path: envPath });
  if (dotenvResult.error) {
    // Use console.error since logger depends on env vars (LOG_LEVEL)
    console.error(`Failed to load .env from ${envPath}: ${dotenvResult.error.message}`);
    console.error('Hint: Copy .env.example to .env and configure your credentials.');
  }
}

// Load archon-owned env from ~/.archon/.env (user scope) and <cwd>/.archon/.env
// (repo scope, wins over user) with override: true. Keeps the server in sync
// with the CLI — see packages/paths/src/env-loader.ts and the three-path model
// (#1302 / #1303).
import { loadArchonEnv } from '@archon/paths/env-loader';
loadArchonEnv(process.cwd());

// CLAUDECODE=1 warning is emitted inside stripCwdEnv() (boot import above)
// BEFORE the marker is deleted from process.env. No duplicate warning here.

// Smart default: use Claude Code's built-in OAuth if no explicit credentials
if (
  !process.env.CLAUDE_API_KEY &&
  !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
  process.env.CLAUDE_USE_GLOBAL_AUTH === undefined
) {
  process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
}

import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';

// Bootstrap provider registry before any provider lookups
registerBuiltinProviders();
registerCommunityProviders();

import { OpenAPIHono, z } from '@hono/zod-openapi';
import { validationErrorHook } from './routes/openapi-defaults';
import {
  TelegramAdapter,
  GitHubAdapter,
  DiscordAdapter,
  SlackAdapter,
  SlackWorkflowBridge,
} from '@archon/adapters';
import { GiteaAdapter } from '@archon/adapters/community/forge/gitea';
import { GitLabAdapter } from '@archon/adapters/community/forge/gitlab';
import { WebAdapter } from './adapters/web';
import { MessagePersistence } from './adapters/web/persistence';
import { SSETransport } from './adapters/web/transport';
import { WorkflowEventBridge } from './adapters/web/workflow-bridge';
import { registerApiRoutes } from './routes/api';
import {
  handleMessage,
  pool,
  ConversationLockManager,
  classifyAndFormatError,
  startCleanupScheduler,
  stopCleanupScheduler,
  loadConfig,
  logConfig,
  getPort,
  createGitHubAppAuthProvider,
  loadAppPrivateKey,
  registerGitHubAppAuthProvider,
  type GitHubAuth,
  type IGitHubAppAuthProvider,
} from '@archon/core';
import type { IPlatformAdapter } from '@archon/core';
import type { IdentityPlatform } from '@archon/core';
import * as userDb from '@archon/core/db/users';
import {
  createLogger,
  logArchonPaths,
  validateAppDefaultsPaths,
  shutdownTelemetry,
  captureArchonStarted,
} from '@archon/paths';
import { selectGitHubAuthMode, parseGitCredentialPath } from './github-auth-bootstrap';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/**
 * Resolve a platform-native user identifier (Slack U-id, Telegram chat id,
 * Discord snowflake) to an Archon user UUID via auto-create-on-first-sight.
 *
 * Contract: NEVER THROWS. On any failure, warn-log and return undefined so
 * message handling proceeds (writes user_id = NULL on the conversation/run
 * row). This invariant is load-bearing — message processing across three
 * adapters depends on it. Covered by resolve-user-id.test.ts.
 *
 * Exported for testability.
 */
export async function resolveUserId(
  platform: IdentityPlatform,
  platformUserId: string | number | undefined,
  displayName: string | undefined
): Promise<string | undefined> {
  if (platformUserId === undefined || platformUserId === '') {
    return undefined;
  }
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity(
      platform,
      String(platformUserId),
      displayName
    );
    return user.id;
  } catch (err) {
    getLog().warn(
      { err: err as Error, platform, platformUserId: String(platformUserId) },
      'server.user_resolve_failed'
    );
    return undefined;
  }
}

/**
 * Creates an error handler for message processing failures.
 * Logs the error and attempts to send a user-friendly message to the platform.
 */
function createMessageErrorHandler(
  platform: string,
  adapter: IPlatformAdapter,
  conversationId: string
): (error: unknown) => Promise<void> {
  return async (error: unknown): Promise<void> => {
    getLog().error({ err: error, platform, conversationId }, 'message_processing_failed');
    try {
      const userMessage = classifyAndFormatError(error as Error);
      await adapter.sendMessage(conversationId, userMessage);
    } catch (sendError) {
      getLog().error({ err: sendError, platform, conversationId }, 'error_message_send_failed');
    }
  };
}

/**
 * Handles unhandled promise rejections from the process.
 *
 * Exported for testability. Filters specifically for SDK cleanup races
 * ("Operation aborted" when the PostToolUse hook writes to a closed pipe after
 * a DAG node abort). Those are logged at error level but do not exit the process.
 * All other unhandled rejections are unexpected bugs — they are logged at fatal
 * level and the process exits immediately (Fail Fast principle).
 */
export function handleUnhandledRejection(reason: unknown): void {
  const message = (reason instanceof Error ? reason.message : String(reason)).toLowerCase();
  // SDK cleanup race: PostToolUse hook writes to a closed pipe after a DAG node
  // abort. Safe to absorb — these are transient artifacts, not application bugs.
  if (message.includes('operation aborted')) {
    getLog().error({ reason }, 'unhandled_rejection.sdk_cleanup_race');
    return;
  }
  // All other unhandled rejections are unexpected — crash loudly so they are
  // not silently swallowed (CLAUDE.md: "Fail Fast + Explicit Errors").
  getLog().fatal({ reason }, 'unhandled_rejection.fatal');
  process.exit(1);
}

export interface ServerOptions {
  /**
   * Override the web dist path (for CLI binary with downloaded web-dist).
   * Only effective in production mode (NODE_ENV=production or WEB_UI_DEV unset).
   */
  webDistPath?: string;
  /** Override the port. Range: 1–65535. */
  port?: number;
  /** Run in standalone web-only mode (no Telegram/Slack/GitHub/Discord adapters). */
  skipPlatformAdapters?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  getLog().info('server_starting');
  // Anonymous once-per-boot startup event (self-gates on opt-out). Flushed by
  // the shutdownTelemetry() call in the SIGINT/SIGTERM shutdown handler.
  captureArchonStarted({ surface: 'server' });

  // Database auto-detected: SQLite (default) or PostgreSQL (if DATABASE_URL set)
  // No required environment variables - SQLite works out of the box

  // Validate AI assistant credentials (warn if missing, don't fail)
  // Using || intentionally: empty string should be treated as missing credential
  // CLAUDE_USE_GLOBAL_AUTH=true: Use Claude Code's built-in OAuth (from `claude /login`)
  const hasClaudeCredentials = Boolean(
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_USE_GLOBAL_AUTH
  );
  const hasCodexCredentials = process.env.CODEX_ID_TOKEN && process.env.CODEX_ACCESS_TOKEN;

  if (!hasClaudeCredentials && !hasCodexCredentials) {
    getLog().fatal(
      {
        checked: {
          claude: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'],
          codex: ['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN'],
        },
        hints: [
          'Set CLAUDE_USE_GLOBAL_AUTH=true in .env (requires `claude /login` first)',
          'Or set CLAUDE_API_KEY in .env',
          'Or set CODEX_ID_TOKEN + CODEX_ACCESS_TOKEN in .env',
          'See .env.example for all options',
        ],
        envFile: BUNDLED_IS_BINARY ? getArchonEnvPath() : envPath,
      },
      'no_ai_credentials'
    );
    process.exit(1);
  }

  if (!hasClaudeCredentials) {
    getLog().warn(
      { checked: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'] },
      'claude_credentials_missing'
    );
  }
  if (!hasCodexCredentials) {
    getLog().warn(
      { checked: ['CODEX_ID_TOKEN', 'CODEX_ACCESS_TOKEN'] },
      'codex_credentials_missing'
    );
  }

  // Test database connection
  try {
    await pool.query('SELECT 1');
    getLog().info('database_connected');
  } catch (error) {
    getLog().fatal({ err: error }, 'database_connection_failed');
    process.exit(1);
  }

  const config = await loadConfig();
  logConfig(config);

  // Start cleanup scheduler
  startCleanupScheduler();

  // Note: orphaned-run cleanup intentionally NOT called at server startup.
  // Running it here killed parallel workflow runs from other processes
  // (CLI, adapters) by flipping their `running` rows to `failed` mid-flight.
  // Same lesson the CLI already learned — see packages/cli/src/cli.ts:256-258.
  // Per CLAUDE.md "No Autonomous Lifecycle Mutation Across Process Boundaries":
  // surface ambiguous state to users and provide a one-click action instead.
  // Users transition a stuck `running` row via the per-row Cancel/Abandon
  // buttons in the Web UI dashboard, or `archon workflow abandon <run-id>`.
  // (`archon workflow cleanup` is a separate command that deletes OLD terminal
  // rows for disk hygiene — it does not handle stuck `running` rows.)
  // See #1216.

  // Log Archon paths configuration
  logArchonPaths();

  // Validate app defaults paths (non-blocking, just logs warnings)
  await validateAppDefaultsPaths();

  // Initialize conversation lock manager
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_CONVERSATIONS ?? '10');
  const lockManager = new ConversationLockManager(maxConcurrent);
  getLog().info({ maxConcurrent }, 'lock_manager_initialized');

  // Initialize web adapter (always enabled)
  // Note: Circular references between transport/persistence/workflowBridge are safe because:
  // - transport's cleanup callback references persistence/workflowBridge (declared after, but
  //   only invoked from a grace period timer — well after all constructors complete)
  // - persistence's emitEvent closure references transport.emit (same lazy pattern)
  const transport = new SSETransport(conversationId => {
    // Flush (not clear!) — the orchestrator/workflow may still be writing messages
    // even though the SSE stream disconnected. Clearing the dbId mapping would cause
    // all subsequent messages to be lost (never persisted to DB).
    void persistence.flush(conversationId).catch((e: unknown) => {
      getLog().error({ conversationId, err: e }, 'transport_cleanup_flush_failed');
    });
  });
  const persistence = new MessagePersistence((conversationId, event) =>
    transport.emit(conversationId, event)
  );
  const workflowBridge = new WorkflowEventBridge(transport);
  const webAdapter = new WebAdapter(transport, persistence, workflowBridge);
  await webAdapter.start();
  persistence.startPeriodicFlush();

  // Mutable — pushed to as each adapter starts, read by the /api/health endpoint.
  // Must be a live reference because Telegram starts after the HTTP listener begins
  // accepting requests, so a snapshot taken at registration time would miss it.
  const activePlatforms: string[] = ['Web'];

  // Platform adapters (skipped in CLI serve mode or when not configured)
  let github: GitHubAdapter | null = null;
  let githubAppAuthProvider: IGitHubAppAuthProvider | null = null;
  let gitea: GiteaAdapter | null = null;
  let gitlab: GitLabAdapter | null = null;
  let discord: DiscordAdapter | null = null;
  let slack: SlackAdapter | null = null;
  let slackBridge: SlackWorkflowBridge | null = null;

  if (!opts.skipPlatformAdapters) {
    // Check that at least one platform is configured
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const hasDiscord = Boolean(process.env.DISCORD_BOT_TOKEN);
    // GitHub adapter: dual-mode (App vs PAT). Fail fast if both are configured —
    // silently preferring one would create 3am debugging sessions for an operator
    // who copy-pasted half a config and didn't realise the other half was already
    // set in /etc/archon/.env. (PRD: "fail-fast on misconfig".)
    const ghAuthMode = selectGitHubAuthMode(process.env);
    if (ghAuthMode.kind === 'conflict') {
      throw new Error(ghAuthMode.message);
    }
    const hasGitHub = ghAuthMode.kind !== 'none';
    const hasGitea = Boolean(
      process.env.GITEA_URL && process.env.GITEA_TOKEN && process.env.GITEA_WEBHOOK_SECRET
    );
    const hasGitLab = Boolean(process.env.GITLAB_TOKEN && process.env.GITLAB_WEBHOOK_SECRET);

    if (!hasTelegram && !hasDiscord && !hasGitHub && !hasGitea && !hasGitLab) {
      getLog().warn('no_platform_adapters_configured');
    }

    if (ghAuthMode.kind === 'app') {
      // Locals avoid `!` non-null assertions: hasGitHubApp already guarantees
      // GITHUB_APP_ID and WEBHOOK_SECRET are set, but the linter can't infer that.
      const appId = process.env.GITHUB_APP_ID;
      const webhookSecret = process.env.WEBHOOK_SECRET;
      if (!appId || !webhookSecret) {
        throw new Error('GitHub App mode misconfigured: GITHUB_APP_ID and WEBHOOK_SECRET required');
      }
      const privateKey = loadAppPrivateKey();
      const defaultInstallationId = process.env.GITHUB_APP_INSTALLATION_ID
        ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
        : undefined;
      githubAppAuthProvider = createGitHubAppAuthProvider({
        appId,
        privateKey,
        slug: process.env.GITHUB_APP_SLUG ?? 'archon',
        defaultInstallationId,
      });
      // Register on the module-level singleton consumed by createWorkflowDeps()
      // so bash/script subprocess env injection picks up the provider.
      registerGitHubAppAuthProvider(githubAppAuthProvider);
      const botMention =
        process.env.GITHUB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      const auth: GitHubAuth = { kind: 'app', provider: githubAppAuthProvider };
      github = new GitHubAdapter(auth, webhookSecret, lockManager, botMention);
      await github.start();
      activePlatforms.push('GitHub (App)');
      getLog().info(
        { slug: githubAppAuthProvider.slug, defaultInstallationId },
        'github.adapter_mode_app'
      );
    } else if (ghAuthMode.kind === 'pat') {
      const patToken = process.env.GITHUB_TOKEN;
      const webhookSecret = process.env.WEBHOOK_SECRET;
      if (!patToken || !webhookSecret) {
        throw new Error('GitHub PAT mode misconfigured: GITHUB_TOKEN and WEBHOOK_SECRET required');
      }
      const botMention =
        process.env.GITHUB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      const auth: GitHubAuth = { kind: 'pat', token: patToken };
      github = new GitHubAdapter(auth, webhookSecret, lockManager, botMention);
      await github.start();
      activePlatforms.push('GitHub');
      getLog().info('github.adapter_mode_pat');
    } else {
      getLog().info('github_adapter_skipped');
    }

    // Initialize Gitea adapter (conditional)
    if (process.env.GITEA_URL && process.env.GITEA_TOKEN && process.env.GITEA_WEBHOOK_SECRET) {
      const giteaBotMention =
        process.env.GITEA_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      gitea = new GiteaAdapter(
        process.env.GITEA_URL,
        process.env.GITEA_TOKEN,
        process.env.GITEA_WEBHOOK_SECRET,
        lockManager,
        giteaBotMention
      );
      await gitea.start();
      activePlatforms.push('Gitea');
    } else {
      getLog().info('gitea_adapter_skipped');
    }

    // Initialize GitLab adapter (conditional)
    if (process.env.GITLAB_TOKEN && process.env.GITLAB_WEBHOOK_SECRET) {
      const gitlabBotMention =
        process.env.GITLAB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      gitlab = new GitLabAdapter(
        process.env.GITLAB_TOKEN,
        process.env.GITLAB_WEBHOOK_SECRET,
        lockManager,
        process.env.GITLAB_URL || undefined,
        gitlabBotMention
      );
      await gitlab.start();
      activePlatforms.push('GitLab');
    } else {
      getLog().info('gitlab_adapter_skipped');
    }

    // Initialize Discord adapter (conditional)
    if (process.env.DISCORD_BOT_TOKEN) {
      const discordStreamingMode = (process.env.DISCORD_STREAMING_MODE ?? 'batch') as
        | 'stream'
        | 'batch';
      discord = new DiscordAdapter(process.env.DISCORD_BOT_TOKEN, discordStreamingMode);
      const discordAdapter = discord; // Capture for use in callback

      // Register message handler
      discordAdapter.onMessage(async ({ message, platformUserId, displayName }) => {
        // Get initial conversation ID
        let conversationId = discordAdapter.getConversationId(message);

        // Skip if no content
        if (!message.content) return;

        // Check if bot was mentioned (required for activation)
        // Exception: DMs don't require mention
        const isDM = !message.guild;
        if (!isDM && !discordAdapter.isBotMentioned(message)) {
          return; // Ignore messages that don't mention the bot
        }

        // Strip the bot mention from the message
        const content = discordAdapter.stripBotMention(message);
        if (!content) return; // Message was only a mention with no content

        // Ensure we're responding in a thread - creates one if needed
        conversationId = await discordAdapter.ensureThread(conversationId, message);

        // Check for thread context (now we're guaranteed to be in a thread if applicable)
        let threadContext: string | undefined;
        let parentConversationId: string | undefined;

        if (discordAdapter.isThread(message)) {
          // Fetch thread history for context (exclude current message)
          const history = await discordAdapter.fetchThreadHistory(message);
          if (history.length > 1) {
            threadContext = history.slice(0, -1).join('\n');
          }

          // Get parent channel ID for context inheritance
          parentConversationId = discordAdapter.getParentChannelId(message) ?? undefined;
        }

        // Resolve Discord author → Archon user UUID.
        // displayName is already display-quality on Discord (no extra API call needed).
        const userId = await resolveUserId('discord', platformUserId, displayName);

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(discordAdapter, conversationId, content, {
              threadContext,
              parentConversationId,
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
              userId,
            });
          })
          .catch(createMessageErrorHandler('Discord', discordAdapter, conversationId));
      });

      // Don't let a Discord login failure (bad token, missing privileged
      // intents, etc.) bring down the whole server — users running
      // `archon serve` for the web UI shouldn't lose it because of an
      // unrelated bot misconfiguration. See #1365.
      try {
        await discord.start();
        activePlatforms.push('Discord');
      } catch (error) {
        const err = error as Error;
        const isPrivilegedIntentError = err.message?.includes('disallowed intents');
        const hint = isPrivilegedIntentError
          ? 'Enable "Message Content Intent" in the Discord Developer Portal ' +
            '(your application > Bot > Privileged Gateway Intents) and restart, ' +
            'or unset DISCORD_BOT_TOKEN if you do not want the Discord adapter.'
          : 'Verify DISCORD_BOT_TOKEN is valid, or unset it to disable the Discord adapter.';
        getLog().error({ err, hint }, 'discord.start_failed_continuing_without_adapter');
        discord = null;
      }
    } else {
      getLog().info('discord_adapter_skipped');
    }

    // Initialize Slack adapter (conditional)
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      const slackStreamingMode = (process.env.SLACK_STREAMING_MODE ?? 'batch') as
        | 'stream'
        | 'batch';
      slack = new SlackAdapter(
        process.env.SLACK_BOT_TOKEN,
        process.env.SLACK_APP_TOKEN,
        slackStreamingMode
      );
      const slackAdapter = slack; // Capture for use in callback

      // Register message handler
      slackAdapter.onMessage(async event => {
        const conversationId = slackAdapter.getConversationId(event);

        // Skip if no text
        if (!event.text) return;

        // Strip the bot mention from the message
        const content = slackAdapter.stripBotMention(event.text);
        if (!content) return; // Message was only a mention with no content

        // Check for thread context
        let threadContext: string | undefined;
        let parentConversationId: string | undefined;

        if (slackAdapter.isThread(event)) {
          // Fetch thread history for context (exclude current message)
          const history = await slackAdapter.fetchThreadHistory(event);
          if (history.length > 1) {
            threadContext = history.slice(0, -1).join('\n');
          }

          // Get parent conversation ID for context inheritance
          parentConversationId = slackAdapter.getParentConversationId(event) ?? undefined;
        }

        // Resolve Slack user → Archon user UUID. displayName comes from
        // the adapter's users.info enrichment (cached per slackUserId).
        const userId = await resolveUserId('slack', event.user, event.displayName);

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(slackAdapter, conversationId, content, {
              threadContext,
              parentConversationId,
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
              userId,
            });
          })
          .catch(createMessageErrorHandler('Slack', slackAdapter, conversationId));
      });

      // Attach the workflow bridge BEFORE app.start(): Bolt's Socket Mode
      // refuses new event-handler registrations once the connection is open,
      // so `app.action(...)` calls inside the bridge must run first.
      slackBridge = new SlackWorkflowBridge(slack);
      slackBridge.attach();

      await slack.start();
      activePlatforms.push('Slack');
    } else {
      getLog().info('slack_adapter_skipped');
    }
  } else {
    getLog().info('platform_adapters_skipped');
  }

  // Setup Hono server
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const port = opts.port ?? (await getPort());

  // Global error handler for unhandled exceptions
  app.onError((err, c) => {
    getLog().error({ err, path: c.req.path, method: c.req.method }, 'unhandled_request_error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Register Web UI API routes
  registerApiRoutes(app, webAdapter, lockManager, activePlatforms);

  // GitHub webhook endpoint
  if (github) {
    app.post('/webhooks/github', async c => {
      const eventType = c.req.header('x-github-event');
      const deliveryId = c.req.header('x-github-delivery');

      try {
        const signature = c.req.header('x-hub-signature-256');
        if (!signature) {
          return c.json({ error: 'Missing signature header' }, 400);
        }

        // CRITICAL: Use c.req.text() for raw body (signature verification)
        const payload = await c.req.text();

        // Process async (fire-and-forget for fast webhook response)
        // Note: github.handleWebhook() has internal error handling that notifies users
        // This catch is a fallback for truly unexpected errors (e.g., signature verification bugs)
        github.handleWebhook(payload, signature).catch((error: unknown) => {
          getLog().error({ err: error, eventType, deliveryId }, 'webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType, deliveryId }, 'webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('github_webhook_registered');
  }

  // Internal endpoint: git credential helper.
  //
  // SECURITY: hands out live installation access tokens to anyone who can hit
  // this URL. MUST be exposed on 127.0.0.1 only — the reverse proxy in front
  // of Archon must NOT forward `/internal/*`. The startup WARN below fires when
  // the operator binds the server to 0.0.0.0 with App mode active, making the
  // misconfiguration obvious in logs.
  if (github?.getAuthMode() === 'app') {
    // Request schema for /internal/git-credential. Validates the small
    // host/path payload the credential helper sends. Inline declaration
    // because the endpoint is a one-off internal surface (not part of the
    // OpenAPI-published API), so it doesn't belong in routes/schemas/.
    const gitCredentialRequestSchema = z.object({
      host: z.string().optional(),
      path: z.string().optional(),
    });

    app.post('/internal/git-credential', async c => {
      try {
        const raw = await c.req.json().catch(() => null);
        const parseResult = gitCredentialRequestSchema.safeParse(raw);
        if (!parseResult.success || parseResult.data.host !== 'github.com') {
          return c.json({ error: 'unsupported host' }, 400);
        }
        const parsed = parseGitCredentialPath(parseResult.data.path ?? '');
        if (!parsed) {
          return c.json({ error: 'unparseable path' }, 400);
        }
        const token = await github.getInstallationToken(parsed.owner, parsed.repo);
        return c.json({ token });
      } catch (err) {
        // ERROR (not WARN): this is a live credential-vending failure. If we
        // can't issue a token, every workflow `git push` and `gh` call against
        // that repo will start failing — operators need this surfaced loudly.
        getLog().error({ err }, 'internal.git_credential_resolve_failed');
        return c.json({ error: 'resolution failed' }, 500);
      }
    });
    getLog().info('internal_git_credential_endpoint_registered');
  }

  // Gitea webhook endpoint
  if (gitea) {
    app.post('/webhooks/gitea', async c => {
      const eventType = c.req.header('x-gitea-event');

      try {
        const signature = c.req.header('x-gitea-signature');
        if (!signature) {
          return c.json({ error: 'Missing signature header' }, 400);
        }

        // CRITICAL: Use c.req.text() for raw body (signature verification)
        const payload = await c.req.text();

        // Process async (fire-and-forget for fast webhook response)
        gitea.handleWebhook(payload, signature).catch((error: unknown) => {
          getLog().error({ err: error, eventType }, 'gitea_webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType }, 'gitea_webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('gitea_webhook_registered');
  }

  // GitLab webhook endpoint
  if (gitlab) {
    app.post('/webhooks/gitlab', async c => {
      const eventType = c.req.header('x-gitlab-event');

      try {
        const token = c.req.header('x-gitlab-token');
        if (!token) {
          return c.json({ error: 'Missing token header' }, 400);
        }

        const payload = await c.req.text();

        gitlab.handleWebhook(payload, token).catch((error: unknown) => {
          getLog().error({ err: error, eventType }, 'gitlab.webhook_processing_error');
        });

        return c.text('OK', 200);
      } catch (error) {
        getLog().error({ err: error, eventType }, 'gitlab.webhook_endpoint_error');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
    getLog().info('gitlab_webhook_registered');
  }

  // Health check endpoints
  app.get('/health', c => {
    return c.json({ status: 'ok' });
  });

  app.get('/health/db', async c => {
    try {
      await pool.query('SELECT 1');
      return c.json({ status: 'ok', database: 'connected' });
    } catch (error) {
      getLog().error({ err: error }, 'health_check_db_failed');
      return c.json({ status: 'error', database: 'disconnected' }, 500);
    }
  });

  app.get('/health/concurrency', c => {
    const { active, queuedTotal, maxConcurrent } = lockManager.getStats();
    return c.json({ status: 'ok', active, queuedTotal, maxConcurrent });
  });

  // Serve web UI static files in production
  // Uses import.meta.dir for absolute path (CWD varies with bun --filter)
  if (process.env.NODE_ENV === 'production' || !process.env.WEB_UI_DEV) {
    const { serveStatic } = await import('hono/bun');
    const pathModule = await import('path');
    const webDistPath =
      opts.webDistPath ??
      pathModule.join(pathModule.dirname(pathModule.dirname(import.meta.dir)), 'web', 'dist');

    if (!existsSync(webDistPath)) {
      getLog().warn({ webDistPath }, 'web_dist_not_found');
    }

    app.use('/assets/*', serveStatic({ root: webDistPath }));
    app.use('/favicon.png', serveStatic({ root: webDistPath, path: 'favicon.png' }));
    // SPA fallback - serve index.html for unmatched routes (after all API routes)
    app.get('*', serveStatic({ root: webDistPath, path: 'index.html' }));
  }

  const hostname = process.env.HOST || '0.0.0.0';

  // Security guardrail: /internal/git-credential hands out live installation
  // access tokens. Fail fast (not just WARN) when App mode is active and the
  // server is bound to a non-loopback interface — a WARN line in startup
  // logs is too easy to scroll past, and the failure mode is "anyone on the
  // network who can hit the port pulls a live token". Operators who deliberately
  // firewall externally (so loopback bind would block their reverse proxy's
  // upstream) can opt out via ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1.
  //
  // Runs BEFORE Bun.serve so a rejected config never opens the listening
  // socket — even briefly — and `server_listening` is never logged.
  if (githubAppAuthProvider && hostname !== '127.0.0.1' && hostname !== 'localhost') {
    if (process.env.ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND === '1') {
      getLog().warn({ hostname }, 'github_app.internal_endpoint_exposed_acknowledged');
    } else {
      getLog().fatal({ hostname }, 'github_app.internal_endpoint_public_bind_rejected');
      throw new Error(
        'GitHub App mode is active but the server is bound to a non-loopback ' +
          `interface (${hostname}). The /internal/git-credential endpoint hands out ` +
          'live installation tokens — exposing it would leak credentials to the network. ' +
          'Either bind to 127.0.0.1 (HOST=127.0.0.1), or, if your reverse proxy already ' +
          'drops /internal/* and the upstream needs a non-loopback bind, opt out by ' +
          'setting ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1.'
      );
    }
  }

  const server = Bun.serve({
    fetch: app.fetch,
    hostname,
    port,
    idleTimeout: 255, // Max value (seconds) - prevents SSE connections from being killed
  });
  getLog().info({ port: server.port, hostname }, 'server_listening');

  // Initialize Telegram adapter (conditional, skipped in CLI serve mode)
  let telegram: TelegramAdapter | null = null;
  if (!opts.skipPlatformAdapters && process.env.TELEGRAM_BOT_TOKEN) {
    const streamingMode = (process.env.TELEGRAM_STREAMING_MODE ?? 'stream') as 'stream' | 'batch';
    telegram = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN, streamingMode);
    const telegramAdapter = telegram; // Capture for use in callback

    // Register message handler (auth is handled internally by adapter)
    telegramAdapter.onMessage(
      async ({ conversationId, message, userId: telegramUserId, displayName }) => {
        // Resolve Telegram user id (numeric) → Archon user UUID.
        const userId = await resolveUserId('telegram', telegramUserId, displayName);

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(telegramAdapter, conversationId, message, {
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
              userId,
            });
          })
          .catch(createMessageErrorHandler('Telegram', telegramAdapter, conversationId));
      }
    );

    try {
      await telegramAdapter.start();
      activePlatforms.push('Telegram');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      getLog().error({ err: error, errorType: error.constructor.name }, 'telegram.start_failed');
      telegram = null; // Don't include in active platforms or shutdown
    }
  } else if (!opts.skipPlatformAdapters) {
    getLog().info('telegram_adapter_skipped');
  }

  // Graceful shutdown
  const shutdown = (): void => {
    getLog().info('server_shutting_down');
    stopCleanupScheduler();
    persistence.stopPeriodicFlush();

    // Flush all buffered messages before stopping adapters
    persistence
      .flushAll()
      .catch((e: unknown) => {
        getLog().error({ err: e }, 'shutdown_flush_failed');
      })
      .then(async () => {
        // Stop adapters (these should not throw, but be defensive)
        try {
          telegram?.stop();
          discord?.stop();
          // Detach Slack workflow bridge BEFORE stopping the adapter so a
          // pending debounced chat.update can't fire against a closed socket.
          slackBridge?.detach();
          slack?.stop();
          gitea?.stop();
          gitlab?.stop();
          await webAdapter.stop();
        } catch (error) {
          getLog().error({ err: error }, 'adapter_stop_error');
        }

        // Flush queued telemetry events before pool closes the process.
        await shutdownTelemetry();

        return pool.end();
      })
      .then(() => {
        getLog().info('database_pool_closed');
        process.exit(0);
      })
      .catch((error: unknown) => {
        getLog().error({ err: error }, 'database_pool_close_failed');
        process.exit(1);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Guard against SDK cleanup races: when a DAG node is aborted mid-execution,
  // the Claude Agent SDK's PostToolUse hook may be in-flight. After the hook
  // returns { continue: true }, handleControlRequest() tries to write() back to
  // the subprocess pipe — but the pipe is already closed (abort fired). The
  // write() throws "Operation aborted", which becomes an unhandled rejection
  // because it occurs AFTER the for-await generator loop exits (and thus outside
  // the try/catch in claude.ts). These are SDK cleanup races, not fatal app errors.
  process.on('unhandledRejection', handleUnhandledRejection);

  getLog().info({ activePlatforms, port }, 'server_ready');

  // Non-blocking: warn at startup if gh CLI auth is unavailable
  checkGhAuth().catch((err: unknown) => {
    getLog().debug({ err }, 'gh_auth.check_unexpected_error');
  });
}

/**
 * Run `gh auth status` and warn if it fails.
 * Helps diagnose expired tokens or missing auth before workflows fail.
 */
async function checkGhAuth(): Promise<void> {
  const { execFileAsync } = await import('@archon/git');
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    getLog().info('gh_auth.status_ok');
  } catch {
    getLog().warn(
      'gh_auth.status_failed — gh CLI is not authenticated. Workflows using gh commands may fail. ' +
        'Run `gh auth login` or set GH_TOKEN in .env to fix this.'
    );
  }
}

// Run the application when executed directly (not imported as a library)
if (import.meta.main) {
  startServer().catch(error => {
    getLog().fatal({ err: error }, 'startup_failed');
    process.exit(1);
  });
}
