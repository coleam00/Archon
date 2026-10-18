import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { rm, readFile, writeFile, unlink, mkdir, readdir, stat } from 'fs/promises';
import { join, basename, dirname, resolve } from 'path';
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
import {
  discoverWorkflowsWithConfig,
  isValidWorkflowFolderSegment,
} from '@archon/workflows/workflow-discovery';
import { FIXTURES_DIR } from '@archon/workflows/fixture-layout';
import { parseWorkflow, parseYaml } from '@archon/workflows/loader';
import { resolveWorkflowName } from '@archon/workflows/router';
import { isValidCommandName, isValidWorkflowName } from '@archon/workflows/command-validation';
import { BUNDLED_WORKFLOWS, BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
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

interface RawWorkflowFile {
  absolutePath: string;
  filename: string;
  packaged: boolean;
  parsed: ReturnType<typeof parseWorkflow>;
  /** The file text as read. */
  content: string;
}

async function tryReadWorkflowAt(dir: string, name: string): Promise<RawWorkflowFile | null> {
  const acceptedNames = new Set(name.includes('/') ? [name, basename(name)] : [name]);
  for (const ext of ['yaml', 'yml']) {
    const filename = `${name}.${ext}`;
    const absolutePath = join(dir, filename);
    try {
      const content = await readFile(absolutePath, 'utf-8');
      const parsed = parseWorkflow(content, filename, providerRegistry);
      if (parsed.workflow !== null && !acceptedNames.has(parsed.workflow.name)) continue;
      return { absolutePath, filename, packaged: false, parsed, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

/**
 * The workflow as authored: the YAML mapping before the engine's normalizing
 * transform. The builder edits this shape, and the normalized `workflow` cannot
 * be sent back (validate rejects it), so GET returns both. Parsed with the same
 * parser the loader uses; undefined when the top level is not a mapping.
 */
function authoredForm(content: string): Record<string, unknown> | undefined {
  const raw = parseYaml(content);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

async function findPackagedWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let match: RawWorkflowFile | null = null;
  for (const pack of packs.sort((a, b) => a.localeCompare(b))) {
    if (pack === FIXTURES_DIR) continue;
    if (!isValidWorkflowFolderSegment(pack)) continue;
    const packPath = join(workflowsRoot, pack);
    try {
      if (!(await stat(packPath)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    let workflowFolders: string[];
    try {
      workflowFolders = await readdir(packPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const workflowFolder of workflowFolders.sort((a, b) => a.localeCompare(b))) {
      if (workflowFolder === FIXTURES_DIR) continue;
      if (!isValidWorkflowFolderSegment(workflowFolder)) continue;
      const workflowPath = join(packPath, workflowFolder);
      try {
        if (!(await stat(workflowPath)).isDirectory()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      let workflowEntries: string[];
      try {
        workflowEntries = await readdir(workflowPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const yamlFiles = workflowEntries
        .filter(entry => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort((a, b) => a.localeCompare(b));
      if (yamlFiles.length !== 1) continue;

      const yamlFilename = yamlFiles[0];
      const absolutePath = join(workflowPath, yamlFilename);
      let content: string;
      try {
        content = await readFile(absolutePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const parsed = parseWorkflow(content, yamlFilename, providerRegistry);
      const yamlStem = yamlFilename.replace(/\.ya?ml$/, '');
      const isMalformedTarget =
        parsed.workflow === null && (yamlStem === name || workflowFolder === name);
      if (parsed.workflow?.name !== name && !isMalformedTarget) continue;
      if (match !== null) {
        throw new Error(`Multiple packaged workflows declare the name '${name}'`);
      }
      match = {
        absolutePath,
        filename: `${pack}/${workflowFolder}/${yamlFilename}`,
        packaged: true,
        parsed,
        content,
      };
    }
  }
  return match;
}

async function findWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  return (
    (await tryReadWorkflowAt(workflowsRoot, name)) ??
    (await findPackagedWorkflowAt(workflowsRoot, name))
  );
}

function isBundledWorkflowsRoot(workflowsRoot: string): boolean {
  return resolve(workflowsRoot) === resolve(getBundledWorkflowsPath());
}

function findBundledWorkflow(
  name: string
): { filename: string; parsed: ReturnType<typeof parseWorkflow>; content: string } | null {
  const direct = BUNDLED_WORKFLOWS[name];
  if (direct !== undefined) {
    const filename = `${name}.yaml`;
    const parsed = parseWorkflow(direct, filename, providerRegistry);
    if (parsed.error !== null || parsed.workflow?.name === name) {
      return { filename, parsed, content: direct };
    }
  }

  let match: {
    filename: string;
    parsed: ReturnType<typeof parseWorkflow>;
    content: string;
  } | null = null;
  for (const [filenameStem, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    if (filenameStem === name) continue;
    const filename = `${filenameStem}.yaml`;
    const parsed = parseWorkflow(content, filename, providerRegistry);
    if (parsed.workflow?.name !== name) continue;
    if (match !== null) throw new Error(`Multiple bundled workflows declare the name '${name}'`);
    match = { filename, parsed, content };
  }
  return match;
}

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

export function registerWorkflowListRoute(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/workflows - Discover available workflows
  registerOpenApiRoute(getWorkflowsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir: string | undefined = cwd;

      // Validate caller-supplied cwd against registered codebase paths
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        // Fallback to first codebase's default_cwd
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) {
          workingDir = codebases[0].default_cwd;
        }
      }

      // No project context (no cwd query param and no registered codebases) —
      // pass null to discovery so it returns bundled + home-scoped workflows.
      // This avoids a misleading empty state on first run, before any project
      // is registered, when bundled defaults are present
      const result = await discoverWorkflowsWithConfig(
        workingDir ?? null,
        loadConfig,
        providerRegistry
      );

      // Resolve repo-owner-curated recommended list (per-project only).
      // Filter to names present in the discovered set; preserve declared order.
      // Stale names are silently ignored (advisory).
      const recommended: string[] = [];
      if (workingDir) {
        const repoConfig = await loadRepoConfig(workingDir);
        const declared = repoConfig.recommendedWorkflows ?? [];
        if (declared.length > 0) {
          const discoveredNames = new Set(result.workflows.map(ws => ws.workflow.name));
          const seen = new Set<string>();
          for (const name of declared) {
            if (discoveredNames.has(name) && !seen.has(name)) {
              recommended.push(name);
              seen.add(name);
            } else if (!discoveredNames.has(name)) {
              getLog().debug({ workingDir, name }, 'workflows.recommended_workflow_not_found');
            }
          }
        }
      }

      return c.json({
        workflows: result.workflows.map(ws => ({
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
        })),
        recommended,
        errors:
          result.errors.length > 0
            ? result.errors.map(error => workflowLoadErrorSchema.parse(error))
            : undefined,
      });
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
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // An installed workflow (`owner/plugin:entrypoint`) has no file under a project or
      // home tree to find by name; it resolves through the catalog, by the same rule the
      // CLI and chat use for a qualified name. Any other name, including a legacy file
      // whose name contains `:`, continues to the file lookups below.
      if (name.includes(':')) {
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
        if (entry) {
          return c.json({
            workflow: Object.assign({}, entry.workflow, entry.declared),
            filename: entry.workflow.name,
            source: entry.source,
          });
        }
      }

      // 1. Try user-defined workflow in cwd.
      if (workingDir) {
        const [workflowFolder] = getWorkflowFolderSearchPaths();
        const projectWorkflowsRoot = join(workingDir, workflowFolder);
        try {
          const hit = await findWorkflowAt(projectWorkflowsRoot, name);
          const isSourceBundledPackage =
            hit?.packaged === true && isBundledWorkflowsRoot(projectWorkflowsRoot);
          if (hit && !isSourceBundledPackage) {
            const result = hit.parsed;
            if (result.error) {
              return apiError(c, 500, `Workflow file is invalid: ${result.error.error}`);
            }
            return c.json({
              workflow: result.workflow,
              authored: authoredForm(hit.content),
              filename: hit.filename,
              source: 'project' as WorkflowSource,
            });
          }
        } catch (err) {
          getLog().error({ err, name }, 'workflow.fetch_failed');
          return apiError(c, 500, 'Failed to read workflow');
        }
      }

      // 2. Fall back to home-scoped workflow (`~/.archon/workflows/`).
      // Mirrors the discovery order in `discoverWorkflowsWithConfig`.
      try {
        const hit = await findWorkflowAt(getHomeWorkflowsPath(), name);
        if (hit) {
          const result = hit.parsed;
          if (result.error) {
            return apiError(c, 500, `Home workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            authored: authoredForm(hit.content),
            filename: hit.filename,
            source: 'global' as WorkflowSource,
          });
        }
      } catch (err) {
        getLog().error({ err, name }, 'workflow.fetch_home_failed');
        return apiError(c, 500, 'Failed to read home-scoped workflow');
      }

      // 3. Fall back to bundled defaults.
      const bundled = findBundledWorkflow(name);
      if (bundled !== null) {
        const result = bundled.parsed;
        if (result.error) {
          return apiError(c, 500, `Bundled workflow is invalid: ${result.error.error}`);
        }
        return c.json({
          workflow: result.workflow,
          authored: authoredForm(bundled.content),
          filename: bundled.filename,
          source: 'bundled' as WorkflowSource,
        });
      }

      if (!isBinaryBuild()) {
        try {
          const hit = await findPackagedWorkflowAt(getBundledWorkflowsPath(), name);
          if (hit) {
            const result = hit.parsed;
            if (result.error) {
              return apiError(c, 500, `Default workflow is invalid: ${result.error.error}`);
            }
            return c.json({
              workflow: result.workflow,
              authored: authoredForm(hit.content),
              filename: hit.filename,
              source: 'bundled' as WorkflowSource,
            });
          }
        } catch (err) {
          getLog().error({ err, name }, 'workflow.fetch_default_failed');
          return apiError(c, 500, 'Failed to read default workflow');
        }
      }

      return apiError(c, 404, `Workflow not found: ${name}`);
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

    const targetSource = c.req.query('source');
    if (targetSource && targetSource !== 'project' && targetSource !== 'global') {
      return apiError(c, 400, 'Invalid workflow source');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (targetSource === 'global') {
      workingDir = undefined;
    } else if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const { definition } = getValidatedBody(c, saveWorkflowBodySchema);

    try {
      const source: WorkflowSource = targetSource === 'global' ? 'global' : 'project';
      const dirPath =
        source === 'global'
          ? getHomeWorkflowsPath()
          : join(workingDir, getWorkflowFolderSearchPaths()[0]);
      const existing = await findWorkflowAt(dirPath, name);
      if (existing?.packaged === true && isBundledWorkflowsRoot(dirPath)) {
        return apiError(c, 400, `Cannot overwrite bundled default workflow: ${name}`);
      }
      const filePath = existing?.absolutePath ?? join(dirPath, `${name}.yaml`);
      const filename = existing?.filename ?? `${name}.yaml`;

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
        filename,
        source,
      });
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

    const targetSource = c.req.query('source');
    if (targetSource && targetSource !== 'project' && targetSource !== 'global') {
      return apiError(c, 400, 'Invalid workflow source');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (targetSource === 'global') {
      workingDir = undefined;
    } else if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const dir =
      targetSource === 'global'
        ? getHomeWorkflowsPath()
        : join(workingDir, getWorkflowFolderSearchPaths()[0]);

    try {
      const packaged = await findPackagedWorkflowAt(dir, name);
      if (packaged !== null) {
        if (isBundledWorkflowsRoot(dir)) {
          return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
        }
        await rm(dirname(packaged.absolutePath), { recursive: true });
        return c.json({ deleted: true, name });
      }
    } catch (err) {
      getLog().error({ err, name }, 'workflow.delete_failed');
      return apiError(c, 500, 'Failed to delete workflow');
    }

    // Remove both `.yaml` and `.yml` variants (discovery accepts either), so a
    // twin file can't stay active after a reported deletion.
    let deleted = false;
    for (const ext of ['yaml', 'yml']) {
      const filePath = join(dir, `${name}.${ext}`);
      try {
        await unlink(filePath);
        deleted = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        getLog().error({ err, name }, 'workflow.delete_failed');
        return apiError(c, 500, 'Failed to delete workflow');
      }
    }
    if (deleted) {
      return c.json({ deleted: true, name });
    }
    if (targetSource !== 'global') {
      try {
        if (findBundledWorkflow(name) !== null) {
          return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
        }
      } catch (err) {
        getLog().error({ err, name }, 'workflow.delete_failed');
        return apiError(c, 500, 'Failed to delete workflow');
      }
    }
    return apiError(c, 404, `Workflow not found: ${name}`);
  });

  // GET /api/commands - List available command names for the workflow node palette
  registerOpenApiRoute(getCommandsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // Collect commands: precedence bundled < global < project (repo-defined wins).
      const commandMap = new Map<string, WorkflowSource>();

      // 1. Seed with bundled defaults
      for (const name of Object.keys(BUNDLED_COMMANDS)) {
        commandMap.set(name, 'bundled');
      }

      // 2. Home-scoped commands (~/.archon/commands/) override bundled
      try {
        const homeCommandsPath = getHomeCommandsPath();
        const files = await findCommandFiles(homeCommandsPath);
        for (const { commandName } of files) {
          commandMap.set(commandName, 'global');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().error({ err }, 'commands.list_home_failed');
        }
        // ENOENT: home commands dir not created yet — not an error
      }

      // 3. Project-defined commands override bundled AND global
      if (workingDir) {
        const searchPaths = getCommandFolderSearchPaths();
        for (const folder of searchPaths) {
          const dirPath = join(workingDir, folder);
          try {
            const files = await findCommandFiles(dirPath);
            for (const { commandName } of files) {
              commandMap.set(commandName, 'project');
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              getLog().error({ err, dirPath }, 'commands.list_project_failed');
            }
            // ENOENT: folder doesn't exist — skip
          }
        }
      }

      const commands = Array.from(commandMap.entries()).map(([name, source]) => ({ name, source }));
      return c.json({ commands });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });
}
