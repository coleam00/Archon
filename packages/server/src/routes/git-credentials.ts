import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { verifyRunToken, verifySessionToken, getDecryptedAccessToken } from '@archon/core';
import { getWorkflowRun } from '@archon/core/db/workflows';
import { getConversationById } from '@archon/core/db/conversations';
import { createLogger } from '@archon/paths';
import { parseGitCredentialPath } from '../github-auth-bootstrap';

let cachedLog: ReturnType<typeof createLogger> | undefined;
/**
 * Lazy getter for the server logger.
 * @returns The logger instance
 */
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/**
 * Dependencies injected into the git credential route handler.
 */
export interface GitCredentialRouteDeps {
  /** GitHub App auth provider for vending installation tokens */
  githubAppAuthProvider?: {
    getInstallationToken: (owner: string, repo: string) => Promise<string>;
  } | null;
  /** Function to verify HMAC run tokens */
  verifyRunToken?: typeof verifyRunToken;
  /** Function to verify HMAC session tokens */
  verifySessionToken?: typeof verifySessionToken;
  /** Function to look up workflow runs */
  getWorkflowRun?: typeof getWorkflowRun;
  /** Function to look up conversations */
  getConversationById?: typeof getConversationById;
  /** Function to retrieve decrypted personal access tokens */
  getDecryptedAccessToken?: typeof getDecryptedAccessToken;
}

// Request schema for /internal/git-credential. Validates the small
// host/path payload the credential helper sends. Inline declaration
// because the endpoint is a one-off internal surface (not part of the
// OpenAPI-published API), so it doesn't belong in routes/schemas/.
const gitCredentialRequestSchema = z.object({
  host: z.string().optional(),
  path: z.string().optional(),
  runId: z.string().optional(),
  runToken: z.string().optional(),
  sessionId: z.string().optional(),
  sessionToken: z.string().optional(),
});

/**
 * Registers the internal /internal/git-credential endpoint on the Hono application.
 *
 * @param app - The OpenAPIHono application instance
 * @param deps - Optional dependency overrides for testing
 */
export function registerGitCredentialRoute(
  app: OpenAPIHono,
  deps: GitCredentialRouteDeps = {}
): void {
  const verifyRun = deps.verifyRunToken ?? verifyRunToken;
  const verifySession = deps.verifySessionToken ?? verifySessionToken;
  const getRun = deps.getWorkflowRun ?? getWorkflowRun;
  const getConversation = deps.getConversationById ?? getConversationById;
  const getAccessToken = deps.getDecryptedAccessToken ?? getDecryptedAccessToken;
  const githubAppAuthProvider = deps.githubAppAuthProvider;

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

      const { runId, runToken, sessionId, sessionToken } = parseResult.data;
      let authenticated = false;

      // Path 1: run-scoped credential (workflow context).
      if (runId && runToken) {
        if (!verifyRun(runId, runToken)) {
          getLog().warn({ runId }, 'internal.git_credential_invalid_run_token');
          return c.json({ error: 'invalid run credential' }, 403);
        }
        const run = await getRun(runId);
        if (!run || !['pending', 'running'].includes(run.status)) {
          getLog().warn({ runId, status: run?.status }, 'internal.git_credential_run_not_active');
          return c.json({ error: 'run not active' }, 403);
        }
        if (run.user_id) {
          const runUserToken = await getAccessToken(run.user_id);
          if (!runUserToken) {
            getLog().warn(
              { runId, userId: run.user_id },
              'internal.git_credential_user_token_missing'
            );
            return c.json({ error: 'user access token missing or expired' }, 403);
          }
          return c.json({ token: runUserToken });
        }
        authenticated = true;
      } else if (sessionId && sessionToken) {
        // Path 2: session-scoped credential (orchestrator / direct-chat context — issue #223).
        if (!verifySession(sessionId, sessionToken)) {
          getLog().warn({ sessionId }, 'internal.git_credential_invalid_session_token');
          return c.json({ error: 'invalid session credential' }, 403);
        }
        const conversation = await getConversation(sessionId);
        if (conversation?.user_id) {
          const sessionUserToken = await getAccessToken(conversation.user_id);
          if (!sessionUserToken) {
            getLog().warn(
              { sessionId, userId: conversation.user_id },
              'internal.git_credential_user_token_missing'
            );
            return c.json({ error: 'user access token missing or expired' }, 403);
          }
          return c.json({ token: sessionUserToken });
        }
        authenticated = true;
      }

      // Unauthenticated callers must not receive GitHub App tokens
      if (!authenticated) {
        getLog().warn('internal.git_credential_unauthenticated');
        return c.json({ error: 'no valid credential presented' }, 403);
      }

      // App installation token fallback (when GitHub App provider is registered and caller is authenticated)
      if (githubAppAuthProvider) {
        const token = await githubAppAuthProvider.getInstallationToken(parsed.owner, parsed.repo);
        return c.json({ token });
      }

      return c.json({ error: 'no valid credential presented' }, 403);
    } catch (err) {
      // ERROR (not WARN): this is a live credential-vending failure.
      getLog().error({ err }, 'internal.git_credential_resolve_failed');
      return c.json({ error: 'resolution failed' }, 500);
    }
  });
}
