/**
 * GET /api/packs/{pack}/graph: a pack's stage graph in this install, for one codebase's
 * project (`readPackGraph`), the same read `archon pack graph` prints.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { PackNotFoundError, type PackGraph } from '@archon/workflows/pack-graph';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { packGraphResponseSchema } from './schemas/workflow.schemas';

const packGraphParamsSchema = z.object({
  pack: z.string().min(1).openapi({ description: 'The pack key: its folder name' }),
});

const packGraphQuerySchema = z.object({
  codebaseId: z.string().min(1).openapi({
    description: 'The codebase whose project the pack is discovered from and its arrows launch in',
  }),
});

const getPackGraphRoute = createRoute({
  method: 'get',
  path: '/api/packs/{pack}/graph',
  tags: ['Workflows'],
  summary: "A pack's stages, outcomes and run-ended arrows, each active or declared",
  request: { params: packGraphParamsSchema, query: packGraphQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: packGraphResponseSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase not found, or no workflow of the pack was found'),
    500: jsonError('Server error'),
  },
});

export function registerPackGraphRoute(
  app: OpenAPIHono,
  deps: {
    codebaseCwd: (id: string) => Promise<string | null>;
    readPackGraph: (cwd: string, pack: string) => Promise<PackGraph>;
  }
): void {
  openApiRouteRegistrar(app)(getPackGraphRoute, async c => {
    const pack = c.req.param('pack') ?? '';
    const { codebaseId } = getValidatedQuery(c, packGraphQuerySchema);
    const cwd = await deps.codebaseCwd(codebaseId);
    if (cwd === null) return apiError(c, 404, 'Codebase not found');
    try {
      return c.json(await deps.readPackGraph(cwd, pack));
    } catch (error) {
      if (error instanceof PackNotFoundError) return apiError(c, 404, error.message);
      getLog().error({ err: error, codebaseId, pack }, 'read_pack_graph_failed');
      return apiError(c, 500, 'Failed to read the pack graph');
    }
  });
}
