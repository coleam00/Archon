/** GET /api/items: read one item, its runs, open questions and answers (`readItem`). */
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import {
  attentionQueueSource,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import { createWorkflowHostStore } from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import { readItem } from '@archon/workflows/item-read';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { itemReadQuerySchema, itemReadResponseSchema } from './schemas/workflow.schemas';

const getItemRoute = createRoute({
  method: 'get',
  path: '/api/items',
  tags: ['Workflows'],
  summary: 'Read an item: its runs, open questions and answers, oldest first',
  request: { query: itemReadQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: itemReadResponseSchema } },
      description: 'The item',
    },
    400: jsonError('Bad request'),
    404: jsonError('No item under that key in the project'),
    500: jsonError('Server error'),
  },
});

export function registerItemRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const source = attentionQueueSource(createWorkflowStore(), createWorkflowHostStore().isolation);

  registerOpenApiRoute(getItemRoute, async c => {
    const query = getValidatedQuery(c, itemReadQuerySchema);
    try {
      // Read the codebases here so a database failure is a 500. Only the resolver's own
      // refusals (no such project, an ambiguous name) are the caller's 400.
      const codebases = await codebaseDb.listCodebases();
      let projectKey: string;
      try {
        projectKey = (
          await resolveAttentionProject({ listCodebases: async () => codebases }, query.project)
        ).key;
      } catch (refusal) {
        return apiError(c, 400, (refusal as Error).message);
      }
      const read = await readItem(source, projectKey, query.key);
      if (read === null) return apiError(c, 404, `No item '${query.key}' in project ${projectKey}`);
      return c.json(read);
    } catch (error) {
      getLog().error({ err: error }, 'api.item_read_failed');
      return apiError(c, 500, 'Failed to read the item');
    }
  });
}
