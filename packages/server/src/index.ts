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
import { BUNDLED_IS_BINARY } from '@archon/paths';

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

// Load ~/.archon/.env with override — Archon's config always wins over any
// Bun-auto-loaded CWD vars. In binary mode this is the single source of truth.
// In dev mode it overrides CWD vars for keys like DATABASE_URL.
const globalEnvPath = resolve(process.env.HOME ?? '~', '.archon', '.env');
if (existsSync(globalEnvPath)) {
  const globalResult = config({ path: globalEnvPath, override: true });
  if (globalResult.error) {
    console.error(`Failed to load .env from ${globalEnvPath}: ${globalResult.error.message}`);
    console.error('Hint: Check for syntax errors in your ~/.archon/.env file.');
  }
}

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

import { registerBuiltinProviders } from '@archon/providers';

// Bootstrap provider registry before any provider lookups
registerBuiltinProviders();

import { OpenAPIHono } from '@hono/zod-openapi';
import { validationErrorHook } from './routes/openapi-defaults';
import { TelegramAdapter, GitHubAdapter, DiscordAdapter, SlackAdapter } from '@archon/adapters';
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
  createWorkflowStore,
} from '@archon/core';
import type { IPlatformAdapter } from '@archon/core';
import { createLogger, logArchonPaths, validateAppDefaultsPaths } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
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
        envFile: BUNDLED_IS_BINARY ? globalEnvPath : envPath,
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

  // Mark workflow runs orphaned by previous process termination as failed
  void createWorkflowStore()
    .failOrphanedRuns()
    .catch(err => {
      getLog().error({ err }, 'workflow.fail_orphans_failed');
    });

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

  // Platform adapters (skipped in CLI serve mode or when not configured)
  let github: GitHubAdapter | null = null;
  let gitea: GiteaAdapter | null = null;
  let gitlab: GitLabAdapter | null = null;
  let discord: DiscordAdapter | null = null;
  let slack: SlackAdapter | null = null;

  if (!opts.skipPlatformAdapters) {
    // Check that at least one platform is configured
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const hasDiscord = Boolean(process.env.DISCORD_BOT_TOKEN);
    const hasGitHub = Boolean(process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET);
    const hasGitea = Boolean(
      process.env.GITEA_URL && process.env.GITEA_TOKEN && process.env.GITEA_WEBHOOK_SECRET
    );
    const hasGitLab = Boolean(process.env.GITLAB_TOKEN && process.env.GITLAB_WEBHOOK_SECRET);

    if (!hasTelegram && !hasDiscord && !hasGitHub && !hasGitea && !hasGitLab) {
      getLog().warn('no_platform_adapters_configured');
    }

    // Initialize GitHub adapter (conditional)
    if (process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET) {
      const botMention =
        process.env.GITHUB_BOT_MENTION || process.env.BOT_DISPLAY_NAME || config.botName;
      github = new GitHubAdapter(
        process.env.GITHUB_TOKEN,
        process.env.WEBHOOK_SECRET,
        lockManager,
        botMention
      );
      await github.start();
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
      discordAdapter.onMessage(async message => {
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

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(discordAdapter, conversationId, content, {
              threadContext,
              parentConversationId,
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
            });
          })
          .catch(createMessageErrorHandler('Discord', discordAdapter, conversationId));
      });

      await discord.start();
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

        // Fire-and-forget: handler returns immediately, processing happens async
        lockManager
          .acquireLock(conversationId, async () => {
            await handleMessage(slackAdapter, conversationId, content, {
              threadContext,
              parentConversationId,
              isolationHints: { workflowType: 'thread', workflowId: conversationId },
            });
          })
          .catch(createMessageErrorHandler('Slack', slackAdapter, conversationId));
      });

      await slack.start();
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
  registerApiRoutes(app, webAdapter, lockManager);

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
    telegramAdapter.onMessage(async ({ conversationId, message }) => {
      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(telegramAdapter, conversationId, message, {
            isolationHints: { workflowType: 'thread', workflowId: conversationId },
          });
        })
        .catch(createMessageErrorHandler('Telegram', telegramAdapter, conversationId));
    });

    try {
      await telegramAdapter.start();
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
          slack?.stop();
          gitea?.stop();
          gitlab?.stop();
          await webAdapter.stop();
        } catch (error) {
          getLog().error({ err: error }, 'adapter_stop_error');
        }

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

  // Show active platforms
  const activePlatforms = ['Web'];
  if (telegram) activePlatforms.push('Telegram');
  if (discord) activePlatforms.push('Discord');
  if (slack) activePlatforms.push('Slack');
  if (github) activePlatforms.push('GitHub');
  if (gitea) activePlatforms.push('Gitea');
  if (gitlab) activePlatforms.push('GitLab');

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
