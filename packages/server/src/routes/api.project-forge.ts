import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ProjectCodebase, ProjectForgeReader } from '../services/project-forge';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import { codebaseIdParamsSchema } from './schemas/codebase.schemas';
import { projectForgeSchema } from './schemas/forge.schemas';

const getProjectForgeRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/forge',
  tags: ['Codebases'],
  summary: "A project's repository on its forge: facts, counts and the newest open items",
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: projectForgeSchema } },
      description:
        'The forge state. A project with no forge and a failed forge read are states of this resource, not errors.',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

export function registerProjectForgeRoute(
  app: OpenAPIHono,
  deps: {
    getCodebase: (id: string) => Promise<ProjectCodebase | null>;
    userId: (c: Context) => Promise<string | undefined>;
    readProjectForge: ProjectForgeReader;
  }
): void {
  openApiRouteRegistrar(app)(getProjectForgeRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await deps.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      return c.json(await deps.readProjectForge(codebase, await deps.userId(c)));
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'codebases.forge_read_failed');
      return apiError(c, 500, 'Failed to read the project forge');
    }
  });
}
