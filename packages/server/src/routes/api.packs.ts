/**
 * GET /api/packs/{pack}/graph: a pack's stage graph in this install, for one codebase's
 * project (`readPackGraph`), the same read `archon pack graph` prints.
 * GET /api/packs/{pack}/view: the factory view that pack ships, checked against that graph
 * (`readPackView`).
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { isAbsolute } from 'node:path';
import { TriggerFileError } from '@archon/core/workflows/run-ended';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import type { PackViewRead } from '@archon/core/workflows/pack-view';
import { PackNotFoundError, type PackGraph } from '@archon/workflows/pack-graph';
import type { Context } from 'hono';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { packGraphResponseSchema, packViewResponseSchema } from './schemas/workflow.schemas';

const packGraphParamsSchema = z.object({
  pack: z.string().min(1).openapi({ description: 'The pack key: its folder name' }),
});

const packGraphQuerySchema = z.object({
  codebaseId: z.string().min(1).openapi({
    description: 'The codebase whose project the pack is discovered from and its arrows launch in',
  }),
  workflowSource: z.string().min(1).optional().openapi({
    description:
      "An absolute directory the pack's workflows are discovered from instead of the codebase, as a binding's launch.discoveryCwd names it",
  }),
});

/** The graph read's failures, as both routes answer them. */
const packReadErrors = {
  400: jsonError('workflowSource is not an absolute path'),
  404: jsonError('Codebase not found, or no workflow of the pack was found'),
  422: jsonError(
    'A trigger file in the install cannot be read, or the store cannot hold run-ended bindings; the error names the file'
  ),
  500: jsonError('Server error'),
};

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
    ...packReadErrors,
  },
});

const getPackViewRoute = createRoute({
  method: 'get',
  path: '/api/packs/{pack}/view',
  tags: ['Workflows'],
  summary:
    "The factory view a pack ships (.shared/factory-view.json), or null, with what is wrong with it against the pack's graph",
  request: { params: packGraphParamsSchema, query: packGraphQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: packViewResponseSchema } },
      description: 'OK',
    },
    ...packReadErrors,
  },
});

/**
 * Validates the query, finds the codebase and answers with `read` of its checkout, mapping the
 * graph read's failures as the CLI reports them.
 */
async function answerPackRead(
  c: Context,
  deps: { codebaseCwd: (id: string) => Promise<string | null> },
  what: 'graph' | 'view',
  read: (cwd: string, pack: string, workflowSource?: string) => Promise<unknown>
) {
  const pack = c.req.param('pack') ?? '';
  const { codebaseId, workflowSource } = getValidatedQuery(c, packGraphQuerySchema);
  if (workflowSource !== undefined && !isAbsolute(workflowSource))
    return apiError(c, 400, 'workflowSource must be an absolute path');
  const cwd = await deps.codebaseCwd(codebaseId);
  if (cwd === null) return apiError(c, 404, 'Codebase not found');
  try {
    return c.json(await read(cwd, pack, workflowSource));
  } catch (error) {
    if (error instanceof PackNotFoundError) return apiError(c, 404, error.message);
    // The operator's own files: the message names the file and what to fix, as the CLI does.
    if (error instanceof TriggerFileError || error instanceof FileStoreUnsupportedError) {
      getLog().warn({ err: error, codebaseId, pack }, `read_pack_${what}_refused`);
      return apiError(c, 422, error.message);
    }
    getLog().error({ err: error, codebaseId, pack }, `read_pack_${what}_failed`);
    return apiError(c, 500, `Failed to read the pack ${what}`);
  }
}

export function registerPackGraphRoute(
  app: OpenAPIHono,
  deps: {
    codebaseCwd: (id: string) => Promise<string | null>;
    readPackGraph: (cwd: string, pack: string, workflowSource?: string) => Promise<PackGraph>;
  }
): void {
  openApiRouteRegistrar(app)(getPackGraphRoute, c =>
    answerPackRead(c, deps, 'graph', deps.readPackGraph)
  );
}

export function registerPackViewRoute(
  app: OpenAPIHono,
  deps: {
    codebaseCwd: (id: string) => Promise<string | null>;
    readPackView: (cwd: string, pack: string, workflowSource?: string) => Promise<PackViewRead>;
  }
): void {
  openApiRouteRegistrar(app)(getPackViewRoute, c =>
    answerPackRead(c, deps, 'view', deps.readPackView)
  );
}
