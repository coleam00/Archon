import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { rm, stat } from 'fs/promises';
import { normalize } from 'path';
import {
  cloneRepository,
  type CloneOptions,
  inspectProjectBaseBranch,
  ProjectRegistrationError,
  registerFolder,
  registerRepository,
} from '@archon/core';
import {
  ActiveContainerEnvironmentsError,
  ActiveWorktreeEnvironmentsError,
  WorktreeRegistrationChangedError,
} from '@archon/core/db/codebase-delete-error';
import { assertAbsoluteDefaultCwd } from '@archon/core/db/codebase-path';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarDb from '@archon/core/db/env-vars';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import { remoteIdentity } from '@archon/core/services/project-registration-identity';
import { detectProjectKind, ProjectKindDetectionError } from '@archon/core/services/project-kind';
import {
  ConfiguredBaseBranchNotFoundError,
  isWorktreeRegistered,
  removeWorktree,
  toRepoPath,
  toWorktreePath,
} from '@archon/git';
import { canonicalizeProjectPath, isInsideArchonWorkspaces } from '@archon/paths';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { toApiCodebase } from './api-serializers';
import {
  codebaseListResponseSchema,
  codebaseSchema,
  codebaseIdParamsSchema,
  addCodebaseBodySchema,
  renameCodebaseBodySchema,
  inspectBaseBranchBodySchema,
  inspectBaseBranchResponseSchema,
  deleteCodebaseResponseSchema,
  codebaseEnvVarsResponseSchema,
  setEnvVarBodySchema,
  codebaseEnvVarParamsSchema,
  envVarMutationResponseSchema,
} from './schemas/codebase.schemas';
import { codebaseEnvironmentsResponseSchema } from './schemas/config.schemas';

const listCodebasesRoute = createRoute({
  method: 'get',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'List codebases with the newest representative of each resolved repository remote',
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getCodebaseRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Get a codebase by ID',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const inspectBaseBranchRoute = createRoute({
  method: 'post',
  path: '/api/codebases/base-branch',
  tags: ['Codebases'],
  summary: 'Inspect the remote default without registering a project',
  request: {
    body: {
      content: { 'application/json': { schema: inspectBaseBranchBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: inspectBaseBranchResponseSchema } },
      description: 'Base branch inspection',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const addCodebaseRoute = createRoute({
  method: 'post',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'Register a codebase (clone from URL or register local path)',
  request: {
    body: {
      content: { 'application/json': { schema: addCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase already existed',
    },
    201: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase created',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const renameCodebaseRoute = createRoute({
  method: 'patch',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Rename a codebase',
  description:
    'Changes the display name. Refused with 409 when another codebase already uses the name, ' +
    'or when the new name would move the project storage (worktrees, state, logs, artifacts).',
  request: {
    params: codebaseIdParamsSchema,
    body: {
      content: { 'application/json': { schema: renameCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Renamed codebase',
    },
    400: jsonError('Bad request'),
    404: jsonError('Codebase not found'),
    409: jsonError('Name already used, or the rename would move project storage'),
    500: jsonError('Server error'),
  },
});

const deleteCodebaseRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Delete a codebase and clean up associated resources',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteCodebaseResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    409: jsonError('Active container environments or newly registered worktrees require cleanup'),
    500: jsonError('Server error'),
  },
});

const listEnvVarsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'List env vars for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvVarsResponseSchema } },
      description: 'Env vars for codebase',
    },
    404: jsonError('Codebase not found'),
  },
});

const setEnvVarRoute = createRoute({
  method: 'put',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'Set (upsert) an env var for a codebase',
  request: {
    params: codebaseIdParamsSchema,
    body: { content: { 'application/json': { schema: setEnvVarBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var set',
    },
    404: jsonError('Codebase not found'),
  },
});

const deleteEnvVarRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}/env/{key}',
  tags: ['Codebases'],
  summary: 'Delete an env var from a codebase',
  request: { params: codebaseEnvVarParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var deleted',
    },
    404: jsonError('Codebase not found'),
  },
});

const getCodebaseEnvironmentsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/environments',
  tags: ['Codebases'],
  summary: 'List isolation environments for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvironmentsResponseSchema } },
      description: 'List of isolation environments',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

export function registerCodebaseRoutes(
  app: OpenAPIHono,
  registration: Pick<CloneOptions, 'githubAppAuth'>
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/codebases - List codebases
  registerOpenApiRoute(listCodebasesRoute, async c => {
    try {
      const codebases = await codebaseDb.listCodebaseClaims();

      const seen = new Map<string, (typeof codebases)[number]>();
      const deduped: (typeof codebases)[number][] = [];
      for (const cb of codebases) {
        let key: string;
        try {
          assertAbsoluteDefaultCwd(cb.default_cwd, cb.name);
          if (cb.kind === 'folder' || !cb.repository_url) {
            deduped.push(cb);
            continue;
          }
          key = await remoteIdentity(cb.repository_url, cb.default_cwd);
        } catch (error) {
          getLog().warn(
            { err: error, codebaseId: cb.id, codebaseName: cb.name },
            'list_codebases_remote_identity_unavailable'
          );
          // Unknown identity cannot establish equality and must not hide a project.
          deduped.push(cb);
          continue;
        }
        const existing = seen.get(key);
        if (!existing || cb.updated_at > existing.updated_at) {
          seen.set(key, cb);
        }
      }
      deduped.push(...seen.values());
      deduped.sort((a, b) => a.name.localeCompare(b.name));

      return c.json(deduped.map(toApiCodebase));
    } catch (error) {
      getLog().error({ err: error }, 'list_codebases_failed');
      return apiError(c, 500, 'Failed to list codebases');
    }
  });

  // GET /api/codebases/:id - Codebase detail
  registerOpenApiRoute(getCodebaseRoute, async c => {
    try {
      const codebase = await codebaseDb.getCodebase(c.req.param('id') ?? '');
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }
      return c.json(toApiCodebase(codebase));
    } catch (error) {
      getLog().error({ err: error }, 'get_codebase_failed');
      return apiError(c, 500, 'Failed to get codebase');
    }
  });

  registerOpenApiRoute(inspectBaseBranchRoute, async c => {
    const body = getValidatedBody(c, inspectBaseBranchBodySchema);
    try {
      return c.json(await inspectProjectBaseBranch(body, registration), 200);
    } catch (error) {
      if (error instanceof ProjectRegistrationError) return apiError(c, 400, error.message);
      getLog().error({ err: error }, 'inspect_base_branch_failed');
      return apiError(c, 500, `Failed to inspect base branch: ${(error as Error).message}`);
    }
  });

  // POST /api/codebases - Add a project (clone from URL or register local path)
  registerOpenApiRoute(addCodebaseRoute, async c => {
    const body = getValidatedBody(c, addCodebaseBodySchema);

    try {
      let result;
      if ('url' in body) {
        result = await cloneRepository(body.url, {
          ...registration,
          baseBranch: body.base_branch ?? undefined,
        });
      } else if (body.folder === true) {
        result = await registerFolder(body.path, undefined, {
          baseBranch: body.base_branch ?? undefined,
        });
      } else {
        const localPath = await canonicalizeProjectPath(body.path);
        const kind = await detectProjectKind(localPath);
        result =
          kind === 'repo'
            ? await registerRepository(localPath, { baseBranch: body.base_branch ?? undefined })
            : await registerFolder(localPath, undefined, {
                baseBranch: body.base_branch ?? undefined,
              });
      }

      // Fetch the full codebase record for a consistent response
      const codebase = await codebaseDb.getCodebase(result.codebaseId);
      if (!codebase) {
        return apiError(c, 500, 'Codebase created but not found');
      }

      return c.json(toApiCodebase(codebase), result.alreadyExisted ? 200 : 201);
    } catch (error) {
      if (error instanceof ProjectKindDetectionError) {
        getLog().warn({ err: error }, 'api.add_codebase_repo_detect_failed');
        return apiError(c, 500, error.message);
      }
      if (
        error instanceof ProjectRegistrationError ||
        error instanceof ConfiguredBaseBranchNotFoundError
      )
        return apiError(c, 400, error.message);
      getLog().error({ err: error }, 'add_codebase_failed');
      return apiError(
        c,
        500,
        `Failed to add codebase: ${(error as Error).message ?? 'unknown error'}`
      );
    }
  });

  // PATCH /api/codebases/:id - Rename a project
  registerOpenApiRoute(renameCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    const { name } = getValidatedBody(c, renameCodebaseBodySchema);
    try {
      return c.json(toApiCodebase(await codebaseDb.renameCodebase(id, name)), 200);
    } catch (error) {
      if (error instanceof codebaseDb.CodebaseNotFoundError) {
        return apiError(c, 404, 'Codebase not found');
      }
      if (
        error instanceof codebaseDb.CodebaseNameTakenError ||
        error instanceof codebaseDb.CodebaseStorageIdentityChangeError
      ) {
        return apiError(c, 409, error.message);
      }
      getLog().error({ err: error, codebaseId: id }, 'rename_codebase_failed');
      return apiError(c, 500, 'Failed to rename codebase');
    }
  });

  // DELETE /api/codebases/:id - Delete a project and clean up
  registerOpenApiRoute(deleteCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      const environments = await isolationEnvDb.listByCodebase(id);
      const containers = environments.filter(env => env.provider === 'container');
      if (containers.length > 0) {
        throw new ActiveContainerEnvironmentsError(containers.map(env => env.id));
      }
      for (const env of environments.filter(env => env.provider === 'worktree')) {
        try {
          const exists = await stat(env.working_path).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
              throw error;
            }
          );
          if (exists) {
            await removeWorktree(
              toRepoPath(codebase.default_cwd),
              toWorktreePath(env.working_path)
            );
          }
          if (await isWorktreeRegistered(toRepoPath(codebase.default_cwd), env.working_path)) {
            throw new Error('Checkout is still registered with Git');
          }
          await isolationEnvDb.markWorktreeDestroyed(env);
          getLog().info({ path: env.working_path }, 'worktree_removed');
        } catch (wtErr) {
          if (wtErr instanceof WorktreeRegistrationChangedError) {
            return apiError(c, 409, wtErr.message);
          }
          getLog().warn({ err: wtErr, path: env.working_path }, 'worktree_remove_failed');
          return apiError(
            c,
            500,
            `Failed to clean up worktree ${env.id}. Project kept; resolve the cleanup failure and retry deletion.`
          );
        }
      }

      await codebaseDb.deleteCodebase(id, { requireWorktreeCleanup: true });

      // Remove workspace directory from disk — only for Archon-managed repos
      const normalizedCwd = normalize(codebase.default_cwd);
      if (isInsideArchonWorkspaces(normalizedCwd)) {
        try {
          await rm(normalizedCwd, { recursive: true, force: true });
          getLog().info({ path: normalizedCwd }, 'workspace_removed');
        } catch (rmErr) {
          getLog().warn({ err: rmErr, path: codebase.default_cwd }, 'workspace_remove_failed');
          return apiError(
            c,
            500,
            `Project registration deleted, but workspace removal failed at ${normalizedCwd}. Remove this directory manually after resolving the filesystem error.`
          );
        }
      } else {
        getLog().info({ path: codebase.default_cwd }, 'external_repo_skip_deletion');
      }

      return c.json({ success: true });
    } catch (error) {
      if (
        error instanceof ActiveContainerEnvironmentsError ||
        error instanceof ActiveWorktreeEnvironmentsError
      ) {
        return apiError(c, 409, error.message);
      }
      getLog().error({ err: error }, 'delete_codebase_failed');
      return apiError(c, 500, 'Failed to delete codebase');
    }
  });

  // GET /api/codebases/:id/env - List env var keys for a codebase (values never returned)
  registerOpenApiRoute(listEnvVarsRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      const envVars = await envVarDb.getCodebaseEnvVars(id);
      return c.json({ keys: Object.keys(envVars) });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'list_env_vars_failed');
      return apiError(c, 500, 'Failed to list env vars');
    }
  });

  // PUT /api/codebases/:id/env - Set (upsert) an env var
  registerOpenApiRoute(setEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const body = getValidatedBody(c, setEnvVarBodySchema);
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.setCodebaseEnvVar(id, body.key, body.value);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'set_env_var_failed');
      return apiError(c, 500, 'Failed to set env var');
    }
  });

  // DELETE /api/codebases/:id/env/:key - Delete an env var
  registerOpenApiRoute(deleteEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    const key = c.req.param('key') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.deleteCodebaseEnvVar(id, key);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id, key }, 'delete_env_var_failed');
      return apiError(c, 500, 'Failed to delete env var');
    }
  });
}

export function registerCodebaseEnvironmentRoute(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/codebases/:id/environments - List isolation environments for a codebase
  registerOpenApiRoute(getCodebaseEnvironmentsRoute, async c => {
    try {
      const { id } = c.req.param();
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      const environments = await isolationEnvDb.listByCodebaseWithAge(id);
      return c.json({ environments });
    } catch (error) {
      getLog().error({ err: error }, 'codebases.environments_list_failed');
      return apiError(c, 500, 'Failed to list environments');
    }
  });
}
