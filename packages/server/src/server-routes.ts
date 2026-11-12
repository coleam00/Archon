import { existsSync } from 'fs';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { pool, type ConversationLockManager } from '@archon/core';
import type { GitHubAdapter } from '@archon/adapters';
import { getSourceWebDistDir } from '@archon/paths';
import { serveWebUi } from './static-cache';
import type { WebAdapter } from './adapters/web';
import { registerApiRoutes } from './routes/api';
import type { AttentionRouter } from './services/attention-router';
import type { WebPushDestination } from './services/web-push';
import {
  registerGiteaWebhookRoute,
  registerGitlabWebhookRoute,
  registerGithubWebhookRoute,
  registerWebhookSourceRoutes,
} from './routes/webhooks';
import type { WebhookSourcePluginHost } from './services/webhook-source-plugins';
import { parseGitCredentialPath } from './github-auth-bootstrap';
import { getAuth, getSignupMode, isArchonOwnedAuthPath } from './auth';
import type { PlatformAdapters } from './platform-adapters';
import { getLog } from './server-log';

export interface ServerRouteDeps {
  webAdapter: WebAdapter;
  lockManager: ConversationLockManager;
  activePlatforms: readonly string[];
  attention: { webPush: WebPushDestination; router: AttentionRouter };
  adapters: PlatformAdapters;
  webhookSources: WebhookSourcePluginHost | undefined;
  requestResourceStartDrain: (() => void) | undefined;
  webDistPath: string | undefined;
}

/** Registers every HTTP route in precedence order; the SPA fallback comes last. */
export function registerServerRoutes(app: OpenAPIHono, deps: ServerRouteDeps): void {
  const { adapters } = deps;

  // Global error handler for unhandled exceptions
  app.onError((err, c) => {
    getLog().error({ err, path: c.req.path, method: c.req.method }, 'unhandled_request_error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  mountWebAuth(app);

  // Register Web UI API routes
  registerApiRoutes(app, deps.webAdapter, deps.lockManager, deps.activePlatforms, deps.attention, {
    githubAppAuth: adapters.githubAppAuthProvider ?? undefined,
  });

  // GitHub webhook endpoint
  if (adapters.github) {
    registerGithubWebhookRoute(app, adapters.github);
    getLog().info('github_webhook_registered');
  }
  if (deps.webhookSources) {
    registerWebhookSourceRoutes(app, deps.webhookSources, deps.requestResourceStartDrain);
    getLog().info('webhook_sources_registered');
  }
  if (adapters.github?.getAuthMode() === 'app') {
    registerGitCredentialRoute(app, adapters.github);
  }

  // Gitea webhook endpoint
  if (adapters.gitea) {
    registerGiteaWebhookRoute(app, adapters.gitea);
    getLog().info('gitea_webhook_registered');
  }

  // GitLab webhook endpoint
  if (adapters.gitlab) {
    registerGitlabWebhookRoute(app, adapters.gitlab);
    getLog().info('gitlab_webhook_registered');
  }

  registerHealthRoutes(app, deps.lockManager);

  // Serve web UI static files in production
  if (process.env.NODE_ENV === 'production' || !process.env.WEB_UI_DEV) {
    // Without an explicit path this is a source checkout or the Docker image,
    // where the web UI is whatever `bun run build:web` produced. The resolved
    // path is absolute because CWD varies with `bun --filter`.
    const webDistPath = deps.webDistPath ?? getSourceWebDistDir();

    if (!existsSync(webDistPath)) {
      getLog().warn({ webDistPath }, 'web_dist_not_found');
    }

    serveWebUi(app, webDistPath);
  }
}

/**
 * Opt-in web auth (Better Auth). Mount the handler at /api/auth/* AFTER
 * app.onError and BEFORE registerApiRoutes (so it wins over the '*' SPA
 * fallback). getAuth() returns null when web auth is disabled — solo/SQLite
 * installs mount nothing and behave exactly as before.
 *
 * Better Auth's basePath is /api/auth, so its handler is a catch-all under
 * that prefix. Archon ALSO owns a few /api/auth/* routes (status + the GitHub
 * device flow) registered later in registerApiRoutes. To avoid shadowing
 * them, explicitly fall through (next()) for those Archon-owned paths so the
 * later route handlers run; everything else under /api/auth/* is Better Auth.
 * DELETE isn't registered here, so DELETE /api/auth/github is never
 * intercepted either. (Raw app.on, not registerOpenApiRoute: Better Auth is
 * an external handler serving its own non-OpenAPI surface, like the webhooks.)
 */
function mountWebAuth(app: OpenAPIHono): void {
  const webAuth = getAuth();
  if (!webAuth) return;
  // isArchonOwnedAuthPath (in ./auth/config) is the single source of truth for
  // which /api/auth/* paths fall through to Archon's own handlers vs. Better
  // Auth. A guard test asserts every Archon-registered /api/auth/* route is in
  // it, so adding a route without exempting it fails CI rather than 404ing live.
  app.on(['POST', 'GET'], '/api/auth/*', (c, next) => {
    if (isArchonOwnedAuthPath(c.req.path)) return next();
    return webAuth.handler(c.req.raw);
  });
  getLog().info('web_auth.handler_registered');
  // Safe-default signal: web auth is on but no allowlist + no open-signup flag
  // → self-serve registration is OFF. Surface it so an operator who meant to
  // invite teammates isn't silently locked out of signups.
  if (getSignupMode() === 'disabled') {
    getLog().warn(
      {
        hint: 'Set ARCHON_AUTH_ALLOWED_EMAILS to invite users, or ARCHON_AUTH_OPEN_SIGNUP=true for open signup.',
      },
      'web_auth.signup_disabled_no_allowlist'
    );
  }
}

// Request schema for /internal/git-credential. Validates the small
// host/path payload the credential helper sends. Inline declaration
// because the endpoint is a one-off internal surface (not part of the
// OpenAPI-published API), so it doesn't belong in routes/schemas/.
const gitCredentialRequestSchema = z.object({
  host: z.string().optional(),
  path: z.string().optional(),
});

/**
 * Internal endpoint: git credential helper.
 *
 * SECURITY: hands out live installation access tokens to anyone who can hit
 * this URL. MUST be exposed on 127.0.0.1 only — the reverse proxy in front
 * of Archon must NOT forward `/internal/*`. assertInternalEndpointBind (index.ts) refuses
 * to start the server (fatal error) when the operator binds to a non-loopback
 * host with App mode active, unless ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1.
 */
function registerGitCredentialRoute(app: OpenAPIHono, github: GitHubAdapter): void {
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

function registerHealthRoutes(app: OpenAPIHono, lockManager: ConversationLockManager): void {
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
}
