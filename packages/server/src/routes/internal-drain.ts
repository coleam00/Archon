/**
 * Drain control — the host-only switch a deploy uses to manufacture a quiet moment.
 *
 * The app is baked into its image, so shipping a commit recreates the container.
 * Without drain a deploy can only poll `/api/health` and hope every conversation
 * goes idle at once; on a box with several concurrent sessions that moment never
 * arrives. Drain makes it: the server stops admitting new work, finishes what it
 * already holds, and `/api/health` reports `drain.state: 'drained'` once it holds
 * nothing. The deploy swaps then — or, if the budget lapses first, deploys nothing.
 *
 * Registered outside the OpenAPI surface and only when `ARCHON_DRAIN_TOKEN` is set,
 * so an install that has not configured a token has no drain endpoint at all.
 *
 * SECURITY: stopping a production server from accepting work is a capability, so
 * these routes carry their own bearer token rather than relying on `/internal/*`
 * not being proxied. The `/internal/git-credential` bind guard does not cover them:
 * it is fatal and fires only in GitHub App mode, and extending it would refuse to
 * start for every operator on the default Docker bind.
 */

import { timingSafeEqual } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/**
 * An unbounded drain would be indistinguishable from a wedged box, and no deploy
 * legitimately waits an hour for one. Past this the operator should be asking why
 * the box will not go quiet, not extending the wait.
 */
export const MAX_DRAIN_BUDGET_SECONDS = 3600;

const drainRequestSchema = z.object({
  budgetSeconds: z.number().positive().max(MAX_DRAIN_BUDGET_SECONDS),
});

/** The slice of the lock manager these routes drive. */
export type DrainTarget = Pick<ConversationLockManager, 'beginDrain' | 'cancelDrain'>;

/**
 * Constant-time bearer check. Mirrors `verifyWebhookToken` in the GitLab adapter:
 * compare lengths first, since `timingSafeEqual` throws on a length mismatch.
 */
export function isAuthorizedDrainRequest(
  authorizationHeader: string | undefined,
  expectedToken: string
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;
  const received = Buffer.from(authorizationHeader.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function registerInternalDrainRoutes(
  app: OpenAPIHono,
  lockManager: DrainTarget,
  token: string
): void {
  app.post('/internal/drain', async c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const parsed = drainRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: `budgetSeconds must be a number greater than 0 and at most ${MAX_DRAIN_BUDGET_SECONDS}`,
        },
        400
      );
    }
    const status = lockManager.beginDrain(parsed.data.budgetSeconds);
    // WARN: the box has stopped accepting work. An operator reading startup logs
    // after a failed deploy needs to find this without grepping for debug lines.
    getLog().warn(
      { budgetSeconds: parsed.data.budgetSeconds, expiresAt: status.expiresAt },
      'internal.drain_requested'
    );
    return c.json(status);
  });

  app.delete('/internal/drain', c => {
    if (!isAuthorizedDrainRequest(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Idempotent: a deploy's failure path cancels blind, without having to know
    // whether its own drain request ever landed.
    lockManager.cancelDrain();
    getLog().warn('internal.drain_cancelled');
    return c.json({ draining: false });
  });

  getLog().info('internal_drain_endpoint_registered');
}
