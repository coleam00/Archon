/**
 * Remote Coding Agent - Main Entry Point
 * Multi-platform AI coding assistant (Telegram, Discord, GitHub, Gitea, chat plugins)
 */

// Strip CWD .env keys FIRST — before any application imports read process.env.
// Bun auto-loads .env/.env.local/.env.development/.env.production from CWD;
// when `bun run dev:server` is run from inside a target repo those keys leak
// into the server process. stripCwdEnv() removes them before ~/.archon/.env loads.
import '@archon/paths/strip-cwd-env-boot';
// ESM dependencies evaluate before this module's body reads configuration.
import { envPath } from './boot/load-env';
import { BUNDLED_IS_BINARY, getArchonEnvPath } from '@archon/paths';
// Pure env→bool boot helper (zero deps) — safe to import before the heavier
// application imports below. Decides the Claude global-auth sentinel posture.
import {
  shouldDefaultClaudeGlobalAuth,
  hasClaudeBootAuthPosture,
} from './boot/claude-auth-posture';

// Workflow scripts started by this server call back into the CLI through the
// same host command the CLI publishes for its own runs.
import { publishArchonCliCommand } from '@archon/paths/cli-command';
if (!BUNDLED_IS_BINARY) publishArchonCliCommand();

// Smart default: fall back to Claude Code's built-in OAuth (`claude /login`)
// ONLY for solo installs with no explicit credentials. Per-user installs
// (TOKEN_ENCRYPTION_KEY) deliver Claude auth per-request, so the global-auth
// sentinel is skipped there — it's misleading, not load-bearing (#1983).
if (shouldDefaultClaudeGlobalAuth(process.env)) {
  process.env.CLAUDE_USE_GLOBAL_AUTH = 'true';
}

import { getPluginsPath } from '@archon/paths';
import { registerHostProviders } from '@archon/core/providers/register-host-providers';
import { claimPiExtensionProcessError } from '@archon/providers/pi/extension-error-broker';
import { formatCodexSetupDeprecation } from '@archon/providers/codex/setup-env';
import { CODEX_BOOT_CHECKED, readCodexBootAuth } from './boot/codex-auth-posture';

await registerHostProviders();

import { OpenAPIHono } from '@hono/zod-openapi';
import { validationErrorHook } from './routes/openapi-defaults';
import type { TelegramAdapter } from '@archon/adapters';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { retiredAdapterNotices } from '@archon/adapters/retired-adapters';
import { loadPlatformPolicies, loadChatPlugins } from '@archon/core/platforms/chat-plugins';
import { createChatHost } from './chat-host/runtime';
import type { InstalledChatPlugin } from './chat-host/supervisor';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { WebAdapter } from './adapters/web';
import { MessagePersistence } from './adapters/web/persistence';
import { SSETransport } from './adapters/web/transport';
import { WorkflowEventBridge } from './adapters/web/workflow-bridge';
import { DashboardEventPoller } from './adapters/web/dashboard-event-poller';
import { PgNotifyListener } from './adapters/web/pg-notify-listener';
import { AttentionRouter } from './services/attention-router';
import { WebPushDestination } from './services/web-push';
import { loadWebhookSourcePlugins } from './services/webhook-source-plugins';
import { createServerResourceStartHost } from './services/resource-start-hosting';
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
  workflowResumeTargetForRun,
} from './services/workflow-resume-service';
import {
  pool,
  ConversationLockManager,
  startCleanupScheduler,
  stopCleanupScheduler,
  getDbNotificationListener,
  loadConfig,
  logConfig,
  getPort,
  isPerUserGitHubEnabled,
  isPerUserProviderKeysEnabled,
  getDatabaseType,
  assertProviderKeysKeyAtBoot,
  type IGitHubAppAuthProvider,
  type MergedConfig,
} from '@archon/core';
import { recordNodeProcessTrees } from '@archon/workflows/subprocess';
import {
  logArchonPaths,
  validateAppDefaultsPaths,
  shutdownTelemetry,
  captureArchonStarted,
  captureArchonActive,
} from '@archon/paths';
import { selectGitHubAuthMode } from '@archon/core/utils/github-auth-mode';
import { closeAuth, isWebAuthEnabled, assertWebAuthAtBoot } from './auth';
// From the pure config module: tests mock './auth', and the header name must stay real.
import { webAuthHeaderName } from './auth/config';
import {
  NO_PLATFORM_ADAPTERS,
  giteaEnv,
  gitlabEnv,
  startPlatformAdapters,
  startTelegramAdapter,
  type PlatformAdapterContext,
  type PlatformAdapters,
  type PlatformRegistry,
} from './platform-adapters';
import { registerServerRoutes } from './server-routes';
import { getLog } from './server-log';

export function handleUnhandledRejection(reason: unknown): void {
  if (BUNDLED_IS_BINARY && claimPiExtensionProcessError(reason)) return;
  getLog().fatal({ reason }, 'unhandled_rejection.fatal');
  void exitAfterTelemetryFlush(1);
}

export function handleUncaughtException(
  error: Error,
  origin?: NodeJS.UncaughtExceptionOrigin
): void {
  if (BUNDLED_IS_BINARY && claimPiExtensionProcessError(error)) return;
  getLog().fatal({ err: error, origin }, 'uncaught_exception.fatal');
  void exitAfterTelemetryFlush(1);
}

/**
 * Exit after flushing queued telemetry. Boot failures after `archon_started`
 * otherwise drop that event, since `process.exit` skips pending async work.
 */
export async function exitAfterTelemetryFlush(code: number): Promise<never> {
  await shutdownTelemetry();
  process.exit(code);
}

export interface ServerOptions {
  /**
   * Override the web dist path (for CLI binary with downloaded web-dist).
   * Only effective in production mode (NODE_ENV=production or WEB_UI_DEV unset).
   */
  webDistPath?: string;
  /** Override the port. Range: 1–65535. */
  port?: number;
  /** Run in standalone web-only mode (no platform adapters or chat plugins). */
  skipPlatformAdapters?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  await assertSqlStore();
  // Every host bash and script node leads its own process group, so a run's cancel ends
  // that run's node trees, and each node's watcher ends its tree if the server dies.
  // The server never ends every tree at once, so the handle is not kept.
  recordNodeProcessTrees();
  setPlatformPolicies(await loadPlatformPolicies(getPluginsPath(), defaultPlatformPolicies));
  getLog().info('server_starting');
  const chatPlugins = opts.skipPlatformAdapters ? [] : await loadChatPlugins(getPluginsPath());
  reportDeploymentShape(chatPlugins);

  // Phase 2: validate the encryption key the moment per-user provider keys are
  // enabled, regardless of GitHub App configuration. TOKEN_ENCRYPTION_KEY alone
  // is the gate — a malformed key must fail boot here rather than at the first
  // PUT /api/auth/providers/* (when an operator is already wired in).
  // No-op when the feature is disabled.
  assertProviderKeysKeyAtBoot();

  // Database auto-detected: SQLite (default) or PostgreSQL (if DATABASE_URL set)
  // No required environment variables - SQLite works out of the box
  await requireAiCredentials();
  await connectDatabase();

  const config = await loadConfig();
  logConfig(config);

  startCleanupScheduler();

  // Note: orphaned-run cleanup intentionally NOT called at server startup.
  // Running it here killed parallel workflow runs from other processes
  // (CLI, adapters) by flipping their `running` rows to `failed` mid-flight.
  // Same lesson the CLI already learned — see packages/cli/src/cli.ts:256-258.
  // Per AGENTS.md "Do not guess lifecycle ownership":
  // surface ambiguous state to users and provide a one-click action instead.
  // Users transition a stuck `running` row via the per-row Cancel/Abandon
  // buttons in the Web UI dashboard, or `archon workflow abandon <run-id>`.
  // (`archon workflow cleanup` is a separate command that deletes OLD terminal
  // rows for disk hygiene — it does not handle stuck `running` rows.)
  // See #1216.

  logArchonPaths();

  // Validate app defaults paths (non-blocking, just logs warnings)
  await validateAppDefaultsPaths();

  const maxConcurrent = config.concurrency.maxConversations;
  const lockManager = new ConversationLockManager(maxConcurrent);
  getLog().info({ maxConcurrent }, 'lock_manager_initialized');

  const web = await startWebAdapter();
  const dashboard = await startDashboardFeed(web.transport);
  const registry: PlatformRegistry = {
    workflowPlatforms: new Map([[web.adapter.getPlatformType(), web.adapter]]),
    activePlatforms: ['Web'],
  };
  const adapterContext: PlatformAdapterContext = {
    lockManager,
    botName: config.botName,
    registry,
    installedChatIds: new Set(chatPlugins.map(plugin => plugin.descriptor.id)),
  };
  if (!opts.skipPlatformAdapters) warnRetiredAdapters(adapterContext.installedChatIds);
  const chat = await startChatHosting(chatPlugins, config, lockManager, registry);

  // Platform adapters (skipped in CLI serve mode or when not configured)
  let adapters = NO_PLATFORM_ADAPTERS;
  if (opts.skipPlatformAdapters) getLog().info('platform_adapters_skipped');
  else adapters = await startPlatformAdapters(adapterContext);

  // Fail fast on a misconfigured web-auth secret before binding a socket: when
  // web auth is enabled, BETTER_AUTH_SECRET must be long enough to be a real
  // signing key. No-op when web auth is disabled.
  assertWebAuthAtBoot();

  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const port = opts.port ?? (await getPort());
  const resourceStarts = await createResourceStarts();
  registerServerRoutes(app, {
    webAdapter: web.adapter,
    lockManager,
    activePlatforms: registry.activePlatforms,
    attention: { webPush: chat.webPush, router: chat.router },
    adapters,
    webhookSources: resourceStarts.webhookSources,
    requestResourceStartDrain: resourceStarts.requestDrain,
    webDistPath: opts.webDistPath,
  });

  const hostname = process.env.HOST || '0.0.0.0';
  assertInternalEndpointBind(hostname, adapters.githubAppAuthProvider);
  warnWebAuthHeaderTrust(hostname);

  const server = Bun.serve({
    fetch: app.fetch,
    hostname,
    port,
    idleTimeout: 255, // Max value (seconds) - prevents SSE connections from being killed
  });
  // Children must use the bound socket, including explicit overrides and worktree ports.
  process.env.ARCHON_PORT = String(server.port);
  getLog().info({ port: server.port, hostname }, 'server_listening');

  // Telegram starts after the listener (skipped in CLI serve mode).
  const telegram = opts.skipPlatformAdapters ? null : await startTelegramAdapter(adapterContext);

  // Web background runs execute against a hidden worker conversation but deliver
  // to their visible parent; other runs use their owning conversation directly.
  startWorkflowContinuationScheduler(
    createSqlWorkflowHost(),
    run => workflowResumeTargetForRun(run, registry.workflowPlatforms),
    resourceStarts.requestDrain
  );
  if (resourceStarts.hostId)
    getLog().info({ hostId: resourceStarts.hostId }, 'resource_start_host_enabled');

  const shutdown = createShutdown({ web, dashboard, chat, adapters, telegram });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  chat.host.start();
  chat.router.start();

  // Every unhandled rejection or exception exits: vendor error text (such as the Claude
  // SDK's "Operation aborted") must not decide what gets suppressed. The one exception is
  // a stack-attested Pi extension failure, which goes back to the Pi turn that loaded it.
  process.on('unhandledRejection', handleUnhandledRejection);
  process.on('uncaughtException', handleUncaughtException);

  getLog().info({ activePlatforms: registry.activePlatforms, port }, 'server_ready');

  // Non-blocking: warn at startup if gh CLI auth is unavailable
  checkGhAuth().catch((err: unknown) => {
    getLog().debug({ err }, 'gh_auth.check_unexpected_error');
  });
}

async function assertSqlStore(): Promise<void> {
  const { loadStoreSelection } = await import('@archon/core/config/store-selection');
  if ((await loadStoreSelection()) === 'files') {
    const { FileStoreUnsupportedError: fileStoreUnsupportedError } = await import(
      '@archon/workflows/file-store'
    );
    throw new fileStoreUnsupportedError('the server (server routes read SQL)');
  }
}

/**
 * Anonymous once-per-boot startup event (self-gates on opt-out), plus a daily
 * heartbeat. Flushed by the shutdownTelemetry() call in the SIGINT/SIGTERM
 * shutdown handler. Deployment shape is categorical only — booleans/enums
 * derived from which integrations are configured, never the config values
 * themselves. loadArchonEnv() ran at module load, so process.env is final here.
 */
function reportDeploymentShape(chatPlugins: readonly InstalledChatPlugin[]): void {
  const deploymentShape = {
    dbKind: getDatabaseType(),
    webAuthEnabled: isWebAuthEnabled(),
    multiUser: isPerUserProviderKeysEnabled(),
    githubAuthMode: selectGitHubAuthMode(process.env).kind,
    chatPluginIds: chatPlugins.map(plugin => plugin.descriptor.id),
    adapterTelegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adapterDiscord: Boolean(process.env.DISCORD_BOT_TOKEN),
    adapterGitea: giteaEnv(process.env) !== undefined,
    adapterGitlab: gitlabEnv(process.env) !== undefined,
  };
  captureArchonStarted({ surface: 'server', ...deploymentShape });

  // Daily heartbeat so long-running servers stay visible in active-install
  // metrics (a boot-only event undercounts server installs after day one).
  // unref() so the timer never keeps the process alive on shutdown.
  // captureArchonActive is synchronous fire-and-forget (errors swallowed
  // internally) — if it ever becomes async, this callback must not return
  // its promise unhandled.
  const TELEMETRY_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    captureArchonActive({ surface: 'server', ...deploymentShape });
  }, TELEMETRY_HEARTBEAT_INTERVAL_MS).unref();
}

/**
 * Validate AI assistant credentials: warn on each missing provider, exit when none is set.
 * A per-user install (TOKEN_ENCRYPTION_KEY) is a valid posture even with no
 * shared Claude key — auth is delivered per request from the encrypted store,
 * so it must NOT trip the no-credentials exit (#1983).
 */
async function requireAiCredentials(): Promise<void> {
  const hasClaudeCredentials = hasClaudeBootAuthPosture(process.env);
  const codexAuth = readCodexBootAuth(process.env);
  if (codexAuth.deprecated.length > 0) {
    getLog().warn(
      { hint: formatCodexSetupDeprecation(codexAuth.deprecated) },
      'codex_setup_env_deprecated'
    );
  }
  const hasCodexCredentials = codexAuth.hasCredentials;

  if (!hasClaudeCredentials && !hasCodexCredentials) {
    getLog().fatal(
      {
        checked: {
          claude: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'],
          codex: CODEX_BOOT_CHECKED,
        },
        hints: [
          'Set CLAUDE_USE_GLOBAL_AUTH=true in .env (requires `claude /login` first)',
          'Or set CLAUDE_API_KEY in .env',
          `Or set ${CODEX_BOOT_CHECKED.join(' + ')} in .env`,
          'See .env.example for all options',
        ],
        envFile: BUNDLED_IS_BINARY ? getArchonEnvPath() : envPath,
      },
      'no_ai_credentials'
    );
    await exitAfterTelemetryFlush(1);
  }

  if (!hasClaudeCredentials) {
    getLog().warn(
      { checked: ['CLAUDE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USE_GLOBAL_AUTH'] },
      'claude_credentials_missing'
    );
  }
  if (!hasCodexCredentials) {
    getLog().warn({ checked: CODEX_BOOT_CHECKED }, 'codex_credentials_missing');
  }
}

async function connectDatabase(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    getLog().info('database_connected');
  } catch (error) {
    getLog().fatal({ err: error }, 'database_connection_failed');
    await exitAfterTelemetryFlush(1);
  }
}

interface WebPlatform {
  transport: SSETransport;
  persistence: MessagePersistence;
  adapter: WebAdapter;
}

/** The web adapter is always enabled. */
async function startWebAdapter(): Promise<WebPlatform> {
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
  const adapter = new WebAdapter(transport, persistence, workflowBridge);
  await adapter.start();
  persistence.startPeriodicFlush();
  return { transport, persistence, adapter };
}

interface DashboardFeed {
  poller: DashboardEventPoller;
  pgNotifyListener: PgNotifyListener | undefined;
}

/**
 * Stream workflow runs started in ANY process (incl. the `archon` CLI / `--detach`)
 * to the console dashboard. The in-process WorkflowEventBridge only sees runs
 * executed inside the server; this poller follows the store's event feed. On
 * Postgres, LISTEN/NOTIFY wakes it for near-instant push (poll becomes a slow
 * backstop); on SQLite it polls fast.
 */
async function startDashboardFeed(transport: SSETransport): Promise<DashboardFeed> {
  const poller = new DashboardEventPoller(createWorkflowStore());
  const dbNotifier = getDbNotificationListener();
  if (!dbNotifier) {
    await poller.start(transport, 1_500);
    return { poller, pgNotifyListener: undefined };
  }
  await poller.start(transport, 10_000);
  const pgNotifyListener = new PgNotifyListener(dbNotifier, poller);
  await pgNotifyListener.start();
  return { poller, pgNotifyListener };
}

function warnRetiredAdapters(installedChatIds: ReadonlySet<string>): void {
  for (const notice of retiredAdapterNotices(process.env, installedChatIds)) {
    getLog().warn(
      { platform: notice.id, hint: `${notice.guidance} Manual install: ${notice.command}` },
      'chat.bundled_adapter_retired'
    );
  }
}

interface ChatHosting {
  host: ReturnType<typeof createChatHost>;
  webPush: WebPushDestination;
  router: AttentionRouter;
}

async function startChatHosting(
  chatPlugins: readonly InstalledChatPlugin[],
  config: MergedConfig,
  lockManager: ConversationLockManager,
  registry: PlatformRegistry
): Promise<ChatHosting> {
  const inlinePlatforms = new Set(
    chatPlugins
      .filter(plugin => plugin.descriptor.capabilities.runEvents)
      .map(plugin => plugin.descriptor.id)
  );
  const host = createChatHost(
    chatPlugins,
    config.streaming,
    lockManager,
    registry.workflowPlatforms,
    registry.activePlatforms,
    { routes: config.attentionNotices, inlinePlatforms }
  );
  // Each route's activation baseline commits before the router's first scan.
  await Promise.all(host.attentionDestinations.map(destination => destination.activate()));
  const webPush = new WebPushDestination(inlinePlatforms);
  const router = new AttentionRouter([webPush, ...host.attentionDestinations], inlinePlatforms);
  for (const plugin of chatPlugins) {
    getLog().info(
      { plugin: plugin.descriptor.id },
      defaultPlatformPolicies.some(policy => policy.id === plugin.descriptor.id)
        ? 'chat.plugin.registered_superseding_bundled_adapter'
        : 'chat.plugin.registered'
    );
  }
  return { host, webPush, router };
}

async function createResourceStarts(): Promise<{
  webhookSources: Awaited<ReturnType<typeof loadWebhookSourcePlugins>> | undefined;
  hostId: string | undefined;
  requestDrain: (() => void) | undefined;
}> {
  const workflowHost = createSqlWorkflowHost();
  const webhookSourcesConfigPath = process.env.ARCHON_WEBHOOK_SOURCES;
  const webhookSources = webhookSourcesConfigPath
    ? await loadWebhookSourcePlugins(webhookSourcesConfigPath, {
        acceptReceipt: input => workflowHost.deps.store.acceptStartReceipt(input),
        isKnownUser: async id => (await workflowHost.records.users.getUserById(id)) !== null,
        hasDeliveryReceipt: (sourceInstanceId, deliveryId) =>
          workflowHost.deps.store.hasStartReceiptForDelivery(sourceInstanceId, deliveryId),
      })
    : undefined;
  // Explicit only: bindings choose their execution host, so the server never guesses one.
  const hostId = process.env.ARCHON_TRIGGER_HOST?.trim();
  const host = hostId ? createServerResourceStartHost(hostId, workflowHost) : undefined;
  const requestDrain = host ? (): void => void host.requestDrain() : undefined;
  return { webhookSources, hostId, requestDrain };
}

const isLoopbackHost = (hostname: string): boolean =>
  hostname === '127.0.0.1' || hostname === 'localhost';

/**
 * Security guardrail: /internal/git-credential hands out live installation
 * access tokens. Fail fast (not just WARN) when App mode is active and the
 * server is bound to a non-loopback interface — a WARN line in startup
 * logs is too easy to scroll past, and the failure mode is "anyone on the
 * network who can hit the port pulls a live token". Operators who deliberately
 * firewall externally (so loopback bind would block their reverse proxy's
 * upstream) can opt out via ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1.
 *
 * Runs BEFORE Bun.serve so a rejected config never opens the listening
 * socket — even briefly — and `server_listening` is never logged.
 */
function assertInternalEndpointBind(
  hostname: string,
  githubAppAuthProvider: IGitHubAppAuthProvider | null
): void {
  if (!githubAppAuthProvider || isLoopbackHost(hostname)) return;
  if (process.env.ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND === '1') {
    getLog().warn({ hostname }, 'github_app.internal_endpoint_exposed_acknowledged');
    return;
  }
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

/**
 * Security guardrail (advisory): the web identity header (ARCHON_WEB_AUTH_HEADER,
 * see webAuthHeaderName) is trusted as-is — Archon attributes web requests to
 * whoever the header names. That is only sound when Archon is reachable SOLELY
 * through a reverse proxy that authenticates and sets the header (loopback bind).
 * On a non-loopback bind any client that can reach the port can forge it:
 * cosmetic misattribution without per-user GitHub, but in per-user mode a forged
 * header can read/disconnect another user's GitHub connection or bind a
 * device-flow token under their identity. WARN (not fatal) so existing exposed
 * installs without per-user identity keep starting — but the misconfiguration is
 * surfaced. The default header name means the trust is live even when
 * ARCHON_WEB_AUTH_HEADER is unset, so per-user mode alone arms this check.
 * Web auth (Better Auth) also keeps the header active as a fallback (proxy
 * deploys / auth-service sidecar), so an enabled install on a public bind
 * gets the same advisory.
 */
function warnWebAuthHeaderTrust(hostname: string): void {
  const webAuthHeaderTrustActive =
    Boolean(process.env.ARCHON_WEB_AUTH_HEADER) || isPerUserGitHubEnabled() || isWebAuthEnabled();
  if (webAuthHeaderTrustActive && !isLoopbackHost(hostname)) {
    getLog().warn(
      { hostname, headerName: webAuthHeaderName() },
      'web_auth.header_trust_on_public_bind'
    );
  }
}

interface ServerServices {
  web: WebPlatform;
  dashboard: DashboardFeed;
  chat: ChatHosting;
  adapters: PlatformAdapters;
  telegram: TelegramAdapter | null;
}

/** Graceful shutdown: flush buffered messages, stop services, then close the pool and exit. */
function createShutdown(services: ServerServices): () => void {
  return () => {
    getLog().info('server_shutting_down');
    stopCleanupScheduler();
    stopWorkflowContinuationScheduler();
    services.web.persistence.stopPeriodicFlush();

    // Flush all buffered messages before stopping adapters
    services.web.persistence
      .flushAll()
      .catch((e: unknown) => {
        getLog().error({ err: e }, 'shutdown_flush_failed');
      })
      .then(() => stopServices(services))
      .then(() => {
        getLog().info('database_pool_closed');
        process.exit(0);
      })
      .catch((error: unknown) => {
        getLog().error({ err: error }, 'database_pool_close_failed');
        process.exit(1);
      });
  };
}

async function stopServices({
  web,
  dashboard,
  chat,
  adapters,
  telegram,
}: ServerServices): Promise<void> {
  try {
    await chat.router.stop();
    await chat.host.stop();
  } catch (error) {
    getLog().error({ err: error }, 'chat_host_stop_error');
  }
  // Stop adapters (these should not throw, but be defensive)
  try {
    telegram?.stop();
    adapters.discord?.stop();
    adapters.gitea?.stop();
    adapters.gitlab?.stop();
    dashboard.pgNotifyListener?.stop();
    dashboard.poller.stop();
    await web.adapter.stop();
  } catch (error) {
    getLog().error({ err: error }, 'adapter_stop_error');
  }

  // Flush queued telemetry events before pool closes the process.
  await shutdownTelemetry();

  // Release the dedicated Better Auth pool (no-op when web auth is off).
  await closeAuth();

  await pool.end();
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
  startServer().catch(async (error: unknown) => {
    getLog().fatal({ err: error }, 'startup_failed');
    await exitAfterTelemetryFlush(1);
  });
}
