import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { rm, writeFile, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { loadConfig, loadRepoConfig } from '@archon/core';
import * as codebaseDb from '@archon/core/db/codebases';
import { findCommandFiles } from '@archon/core/utils/commands';
import {
  getWorkflowFolderSearchPaths,
  getCommandFolderSearchPaths,
  getBundledWorkflowsPath,
  getHomeCommandsPath,
  getHomeWorkflowsPath,
  isPathInside,
  getArchonHome,
} from '@archon/paths';
import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { parseWorkflow } from '@archon/workflows/loader';
import { resolveWorkflowName } from '@archon/workflows/router';
import { isValidCommandName, isValidWorkflowName } from '@archon/workflows/command-validation';
import { BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import {
  apiError,
  getLog,
  getValidatedBody,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  authoredForm,
  findBundledWorkflow,
  findPackagedWorkflowAt,
  findWorkflowAt,
  isBundledWorkflowsRoot,
} from './workflow-files';
import type { WorkflowFile } from './workflow-files';
import { serializeWorkflowPreservingText, WorkflowReadBackError } from './workflow-yaml';
import {
  workflowListResponseSchema,
  workflowLoadErrorSchema,
  validateWorkflowBodySchema,
  validateWorkflowResponseSchema,
  getWorkflowResponseSchema,
  saveWorkflowBodySchema,
  deleteWorkflowResponseSchema,
  commandListResponseSchema,
  workflowSourceSchema,
} from './schemas/workflow.schemas';

type WorkflowSource = z.infer<typeof workflowSourceSchema>;

const cwdQuerySchema = z.object({ cwd: z.string().optional() });
const workflowTargetQuerySchema = cwdQuerySchema.extend({
  source: z.enum(['project', 'global']).optional(),
});

const getWorkflowsRoute = createRoute({
  method: 'get',
  path: '/api/workflows',
  tags: ['Workflows'],
  summary: 'List available workflows',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const validateWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/validate',
  tags: ['Workflows'],
  summary: 'Validate a workflow definition without saving',
  request: {
    body: {
      content: { 'application/json': { schema: validateWorkflowBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: validateWorkflowResponseSchema } },
      description: 'Validation result',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getWorkflowRoute = createRoute({
  method: 'get',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Fetch a single workflow definition',
  request: {
    params: z.object({ name: z.string() }),
    query: cwdQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Workflow definition',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const saveWorkflowRoute = createRoute({
  method: 'put',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Save (create or update) a workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: workflowTargetQuerySchema,
    body: { content: { 'application/json': { schema: saveWorkflowBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Saved workflow',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Delete a user-defined workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: workflowTargetQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteWorkflowResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getCommandsRoute = createRoute({
  method: 'get',
  path: '/api/commands',
  tags: ['Commands'],
  summary: 'List available command names for the workflow node palette',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: commandListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});
const INVALID_CWD = 'Invalid cwd: must match a registered codebase path';

/**
 * Validate that a caller-supplied `cwd` is rooted at a registered codebase path.
 * This prevents path traversal — callers cannot read/write outside known project roots.
 */
async function validateCwd(cwd: string): Promise<boolean> {
  const codebases = await codebaseDb.listCodebases();
  return codebases.some(cb =>
    isPathInside(cb.default_cwd, cwd, { includeRoot: true, lexical: true })
  );
}

/**
 * The project a request reads from: its validated `cwd`, else the first registered
 * codebase. `path` is undefined when neither exists.
 */
type WorkingDir = { valid: false } | { valid: true; path: string | undefined };

async function resolveWorkingDir(cwd: string | undefined): Promise<WorkingDir> {
  if (cwd) return (await validateCwd(cwd)) ? { valid: true, path: cwd } : { valid: false };
  const codebases = await codebaseDb.listCodebases();
  return { valid: true, path: codebases[0]?.default_cwd };
}

/** The workflows folder PUT and DELETE write to. */
interface WorkflowTarget {
  source: 'project' | 'global';
  dir: string;
}

async function resolveWorkflowTarget(
  query: z.infer<typeof workflowTargetQuerySchema>
): Promise<WorkflowTarget | { error: string }> {
  if (query.source === 'global') return { source: 'global', dir: getHomeWorkflowsPath() };
  const workingDir = await resolveWorkingDir(query.cwd);
  if (!workingDir.valid) return { error: INVALID_CWD };
  const projectRoot = workingDir.path || getArchonHome();
  return { source: 'project', dir: join(projectRoot, getWorkflowFolderSearchPaths()[0]) };
}

/**
 * The repo owner's curated recommended list (per-project only), filtered to discovered
 * names in declared order. Stale names are ignored (advisory).
 */
async function resolveRecommendedWorkflows(
  workingDir: string | undefined,
  discoveredNames: ReadonlySet<string>
): Promise<string[]> {
  if (!workingDir) return [];
  const repoConfig = await loadRepoConfig(workingDir);
  const recommended = new Set<string>();
  for (const name of repoConfig.recommendedWorkflows ?? []) {
    if (discoveredNames.has(name)) recommended.add(name);
    else getLog().debug({ workingDir, name }, 'workflows.recommended_workflow_not_found');
  }
  return [...recommended];
}

type DiscoveredWorkflow = Awaited<
  ReturnType<typeof discoverWorkflowsWithConfig>
>['workflows'][number];

function workflowListEntry(ws: DiscoveredWorkflow): Record<string, unknown> {
  return {
    // Display shows what the AUTHOR wrote. Composition collapses workflow-level
    // node config onto the nodes and removes it (#1764), so the declared values are
    // layered back over the definition for this listing only — the console reads
    // `workflow.provider` to label a card, and execution never reads this response.
    workflow: Object.assign({}, ws.workflow, ws.declared),
    source: ws.source,
    // Keys the engine dropped from this YAML (#2213) — the console is the
    // surface most authors edit workflows on, so it has to carry them.
    ...(ws.parseWarnings && ws.parseWarnings.length > 0
      ? { parseWarnings: [...ws.parseWarnings] }
      : {}),
  };
}

async function listWorkflows(c: Context, workingDir: string | undefined): Promise<Response> {
  // No project context (no cwd query param and no registered codebases) —
  // pass null to discovery so it returns bundled + home-scoped workflows.
  // This avoids a misleading empty state on first run, before any project
  // is registered, when bundled defaults are present
  const result = await discoverWorkflowsWithConfig(
    workingDir ?? null,
    loadConfig,
    providerRegistry
  );
  const discoveredNames = new Set(result.workflows.map(ws => ws.workflow.name));
  return c.json({
    workflows: result.workflows.map(workflowListEntry),
    recommended: await resolveRecommendedWorkflows(workingDir, discoveredNames),
    errors:
      result.errors.length > 0
        ? result.errors.map(error => workflowLoadErrorSchema.parse(error))
        : undefined,
  });
}

/**
 * An installed workflow (`owner/plugin:entrypoint`) has no file under a project or
 * home tree to find by name; it resolves through the catalog, by the same rule the
 * CLI and chat use for a qualified name. Any other name, including a legacy file
 * whose name contains `:`, is left to the file lookups.
 */
async function findInstalledWorkflow(
  name: string,
  workingDir: string | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!name.includes(':')) return undefined;
  const { workflows } = await discoverWorkflowsWithConfig(
    workingDir ?? null,
    loadConfig,
    providerRegistry
  );
  const hit = resolveWorkflowName(
    name,
    workflows.filter(entry => entry.source === 'installed').map(entry => entry.workflow)
  );
  const entry = hit && workflows.find(candidate => candidate.workflow === hit);
  if (!entry) return undefined;
  return {
    workflow: Object.assign({}, entry.workflow, entry.declared),
    filename: entry.workflow.name,
    source: entry.source,
  };
}

/** One place GET /api/workflows/:name looks for a workflow file. */
interface WorkflowLookup {
  source: WorkflowSource;
  /** Prefix of the 500 returned when the file found here does not parse. */
  invalidLabel: string;
  /** Log event and message for a failed read; absent lets the error reach the route's catch. */
  readFailure?: { event: string; message: string };
  find(): Promise<WorkflowFile | null>;
}

/** The workflow lookups in discovery order: project, home, bundled, then source defaults. */
function workflowLookups(name: string, workingDir: string | undefined): WorkflowLookup[] {
  const lookups: WorkflowLookup[] = [];
  if (workingDir) {
    const projectWorkflowsRoot = join(workingDir, getWorkflowFolderSearchPaths()[0]);
    lookups.push({
      source: 'project',
      invalidLabel: 'Workflow file is invalid',
      readFailure: { event: 'workflow.fetch_failed', message: 'Failed to read workflow' },
      find: async () => {
        const hit = await findWorkflowAt(projectWorkflowsRoot, name);
        // A source checkout's own bundled packs are reported as bundled, below.
        const isSourceBundledPackage =
          hit?.packaged === true && isBundledWorkflowsRoot(projectWorkflowsRoot);
        return isSourceBundledPackage ? null : hit;
      },
    });
  }
  lookups.push(
    {
      source: 'global',
      invalidLabel: 'Home workflow file is invalid',
      readFailure: {
        event: 'workflow.fetch_home_failed',
        message: 'Failed to read home-scoped workflow',
      },
      find: () => findWorkflowAt(getHomeWorkflowsPath(), name),
    },
    {
      source: 'bundled',
      invalidLabel: 'Bundled workflow is invalid',
      find: async () => findBundledWorkflow(name),
    }
  );
  if (!isBinaryBuild()) {
    lookups.push({
      source: 'bundled',
      invalidLabel: 'Default workflow is invalid',
      readFailure: {
        event: 'workflow.fetch_default_failed',
        message: 'Failed to read default workflow',
      },
      find: () => findPackagedWorkflowAt(getBundledWorkflowsPath(), name),
    });
  }
  return lookups;
}

async function getWorkflowDefinition(
  c: Context,
  name: string,
  workingDir: string | undefined
): Promise<Response> {
  const installed = await findInstalledWorkflow(name, workingDir);
  if (installed) return c.json(installed);

  for (const lookup of workflowLookups(name, workingDir)) {
    let hit: WorkflowFile | null;
    try {
      hit = await lookup.find();
    } catch (err) {
      if (!lookup.readFailure) throw err;
      getLog().error({ err, name }, lookup.readFailure.event);
      return apiError(c, 500, lookup.readFailure.message);
    }
    if (!hit) continue;
    if (hit.parsed.error) {
      return apiError(c, 500, `${lookup.invalidLabel}: ${hit.parsed.error.error}`);
    }
    return c.json({
      workflow: hit.parsed.workflow,
      authored: authoredForm(hit.content),
      filename: hit.filename,
      source: lookup.source,
    });
  }
  return apiError(c, 404, `Workflow not found: ${name}`);
}

async function saveWorkflowFile(
  c: Context,
  name: string,
  target: WorkflowTarget,
  definition: z.infer<typeof saveWorkflowBodySchema>['definition']
): Promise<Response> {
  const existing = await findWorkflowAt(target.dir, name);
  if (existing?.packaged === true && isBundledWorkflowsRoot(target.dir)) {
    return apiError(c, 400, `Cannot overwrite bundled default workflow: ${name}`);
  }
  const filePath = existing?.absolutePath ?? join(target.dir, `${name}.yaml`);

  // Serialize over the file on disk so the file keeps its comments and anchors
  let yamlContent: string;
  try {
    yamlContent = serializeWorkflowPreservingText(definition, existing?.content);
  } catch (error) {
    if (error instanceof WorkflowReadBackError) {
      // A serializer defect, not bad input: writing would store a different workflow.
      getLog().error({ err: error, name }, 'workflow.save_readback_mismatch');
      return apiError(
        c,
        500,
        'Workflow was not saved: the serialized file would not match the submitted definition'
      );
    }
    const err = error instanceof Error ? error : new Error(String(error));
    getLog().error({ err, name }, 'workflow.serialize_failed');
    return apiError(c, 400, 'Failed to serialize workflow definition');
  }

  const parsed = parseWorkflow(yamlContent, `${name}.yaml`, providerRegistry);
  if (parsed.error) {
    return apiError(c, 400, 'Workflow definition is invalid', parsed.error.error);
  }

  if (yamlContent !== existing?.content) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, yamlContent, 'utf-8');
  }
  return c.json({
    workflow: parsed.workflow,
    filename: existing?.filename ?? `${name}.yaml`,
    source: target.source,
  });
}

/**
 * Remove both `.yaml` and `.yml` variants (discovery accepts either), so a twin
 * file can't stay active after a reported deletion. True when either existed.
 */
async function unlinkWorkflowFiles(dir: string, name: string): Promise<boolean> {
  let deleted = false;
  for (const ext of ['yaml', 'yml']) {
    try {
      await unlink(join(dir, `${name}.${ext}`));
      deleted = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return deleted;
}

async function deleteWorkflowFiles(
  c: Context,
  name: string,
  target: WorkflowTarget
): Promise<Response> {
  const packaged = await findPackagedWorkflowAt(target.dir, name);
  if (packaged !== null) {
    if (isBundledWorkflowsRoot(target.dir)) {
      return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
    }
    await rm(dirname(packaged.absolutePath), { recursive: true });
    return c.json({ deleted: true, name });
  }
  if (await unlinkWorkflowFiles(target.dir, name)) return c.json({ deleted: true, name });
  if (target.source === 'project' && findBundledWorkflow(name) !== null) {
    return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
  }
  return apiError(c, 404, `Workflow not found: ${name}`);
}

/** Command names in `dirPath`; a folder that does not exist yet has none. */
async function listCommandNames(dirPath: string): Promise<string[]> {
  try {
    return (await findCommandFiles(dirPath)).map(file => file.commandName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Every command name with the source that defines it: bundled < global < project. */
async function collectCommandSources(
  workingDir: string | undefined
): Promise<Map<string, WorkflowSource>> {
  const commandMap = new Map<string, WorkflowSource>();
  for (const name of Object.keys(BUNDLED_COMMANDS)) commandMap.set(name, 'bundled');

  try {
    for (const name of await listCommandNames(getHomeCommandsPath())) {
      commandMap.set(name, 'global');
    }
  } catch (err) {
    getLog().error({ err }, 'commands.list_home_failed');
  }

  if (!workingDir) return commandMap;
  for (const folder of getCommandFolderSearchPaths()) {
    const dirPath = join(workingDir, folder);
    try {
      for (const name of await listCommandNames(dirPath)) commandMap.set(name, 'project');
    } catch (err) {
      getLog().error({ err, dirPath }, 'commands.list_project_failed');
    }
  }
  return commandMap;
}

export function registerWorkflowListRoute(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/workflows - Discover available workflows
  registerOpenApiRoute(getWorkflowsRoute, async c => {
    try {
      const workingDir = await resolveWorkingDir(c.req.query('cwd'));
      if (!workingDir.valid) return apiError(c, 400, INVALID_CWD);
      return await listWorkflows(c, workingDir.path);
    } catch (error) {
      // Workflow discovery can fail if cwd is stale or deleted — return empty with warning
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow_discovery_failed');
      return apiError(c, 500, `Workflow discovery failed: ${err.message}`);
    }
  });
}

export function registerWorkflowDefinitionRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // POST /api/workflows/validate - Validate a workflow definition without saving
  // MUST be registered before GET /api/workflows/:name so "validate" is not treated as :name
  registerOpenApiRoute(validateWorkflowRoute, async c => {
    const { definition } = getValidatedBody(c, validateWorkflowBodySchema);

    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    try {
      const result = parseWorkflow(yamlContent, 'validate-input.yaml', providerRegistry);

      if (result.error) {
        return c.json({ valid: false, errors: [result.error.error] });
      }
      return c.json({ valid: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.validate_failed');
      return apiError(c, 500, 'Failed to validate workflow');
    }
  });

  // GET /api/workflows/:name - Fetch a single workflow definition
  registerOpenApiRoute(getWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidWorkflowName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    try {
      const workingDir = await resolveWorkingDir(c.req.query('cwd'));
      if (!workingDir.valid) return apiError(c, 400, INVALID_CWD);
      return await getWorkflowDefinition(c, name, workingDir.path);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.get_failed');
      return apiError(c, 500, 'Failed to get workflow');
    }
  });

  // PUT /api/workflows/:name - Save (create or update) a workflow
  registerOpenApiRoute(saveWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const target = await resolveWorkflowTarget(getValidatedQuery(c, workflowTargetQuerySchema));
    if ('error' in target) return apiError(c, 400, target.error);

    const { definition } = getValidatedBody(c, saveWorkflowBodySchema);
    try {
      return await saveWorkflowFile(c, name, target, definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.save_failed');
      return apiError(c, 500, 'Failed to save workflow');
    }
  });

  // DELETE /api/workflows/:name - Delete a user-defined workflow
  registerOpenApiRoute(deleteWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const target = await resolveWorkflowTarget(getValidatedQuery(c, workflowTargetQuerySchema));
    if ('error' in target) return apiError(c, 400, target.error);

    try {
      return await deleteWorkflowFiles(c, name, target);
    } catch (err) {
      getLog().error({ err, name }, 'workflow.delete_failed');
      return apiError(c, 500, 'Failed to delete workflow');
    }
  });

  // GET /api/commands - List available command names for the workflow node palette
  registerOpenApiRoute(getCommandsRoute, async c => {
    try {
      const workingDir = await resolveWorkingDir(c.req.query('cwd'));
      if (!workingDir.valid) return apiError(c, 400, INVALID_CWD);
      const commandMap = await collectCommandSources(workingDir.path);
      const commands = Array.from(commandMap.entries()).map(([name, source]) => ({ name, source }));
      return c.json({ commands });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });
}
