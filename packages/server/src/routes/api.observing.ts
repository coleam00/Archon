/**
 * GET /api/observing: what this install reads for event bindings without receiving
 * webhooks. The sources this server loaded that observe, with the label reads their
 * bindings name and the label bindings they cannot serve, and the last pass the wake
 * watcher recorded. It does not say whether a scheduler job runs the watcher:
 * `archon workflow wake schedule status` does.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { ObservingSource } from '@archon/core/workflows/source-plugins';
import { wakeLastPassSchema, type WakeLastPassRead } from '@archon/core/workflows/wake-last-pass';
import { jsonError, openApiRouteRegistrar } from './api-route-kit';

export const observingResponseSchema = z
  .object({
    /** The observing sources of the sources file this server started with; none without one. */
    sources: z.array(
      z.object({
        source: z.string(),
        everySeconds: z.number().int(),
        labels: z.array(
          z.object({
            bindingId: z.string(),
            repo: z.object({ host: z.string(), path: z.string() }),
            label: z.string(),
          })
        ),
        unserved: z.array(z.object({ bindingId: z.string(), reason: z.string() })),
      })
    ),
    /** The wake watcher's last recorded pass; null when none is recorded or it does not read. */
    lastPass: wakeLastPassSchema.nullable(),
    /** Why the last-pass record could not be read, when it exists but does not read; else null. */
    lastPassUnreadable: z.string().nullable(),
  })
  .openapi('Observing');

const getObservingRoute = createRoute({
  method: 'get',
  path: '/api/observing',
  tags: ['Workflows'],
  summary: 'The sources this install observes and the last pass its wake watcher recorded',
  responses: {
    200: {
      content: { 'application/json': { schema: observingResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

export function registerObservingRoute(
  app: OpenAPIHono,
  deps: {
    observing: readonly ObservingSource[];
    lastPass: () => Promise<WakeLastPassRead>;
  }
): void {
  openApiRouteRegistrar(app)(getObservingRoute, async c => {
    const recorded = await deps.lastPass();
    return c.json({
      sources: deps.observing.map(source => ({
        source: source.sourceInstanceId,
        everySeconds: source.everySeconds,
        labels: [...source.labels],
        unserved: [...source.unservedBindings],
      })),
      lastPass: recorded.kind === 'read' ? recorded.pass : null,
      lastPassUnreadable: recorded.kind === 'unreadable' ? recorded.reason : null,
    });
  });
}
