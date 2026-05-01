/**
 * Compass routes — visual canvas for "what feature to build next".
 *
 * Compass overlays user-drafted "ghost" features on top of an extracted graph
 * of the codebase's existing features ("real"), and asks the configured AI
 * assistant to score each ghost against a per-codebase north star.
 *
 * Per-codebase persistence:
 *   - <repo>/.archon/north-star.yaml  (version-controlled, user-authored)
 *   - <repo>/.archon/state/compass.json  (gitignored, server-managed)
 *
 * The /annotate path makes a direct, synchronous AI call via getAgentProvider
 * (mirroring services/title-generator.ts) rather than dispatching a workflow.
 * v1 returns the full annotation in the response body — no SSE streaming.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { join, relative } from 'path';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import * as codebaseDb from '@archon/core/db/codebases';
import * as conversationDb from '@archon/core/db/conversations';
import { handleMessage, ConversationLockManager } from '@archon/core';
import { getAgentProvider } from '@archon/providers';
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';
import type { WebAdapter } from '../adapters/web';
import {
  compassCodebaseIdParamsSchema,
  compassGhostIdParamsSchema,
  compassGraphResponseSchema,
  upsertGhostBodySchema,
  upsertGhostResponseSchema,
  deleteGhostResponseSchema,
  annotateGhostBodySchema,
  annotateGhostResponseSchema,
  promoteGhostBodySchema,
  promoteGhostResponseSchema,
  northStarSchema,
  realFeatureNodeSchema,
  realFeatureEdgeSchema,
  ghostFeatureNodeSchema,
  annotationSchema,
} from './schemas/compass.schemas';
import { errorSchema } from './schemas/common.schemas';

type RealNode = z.infer<typeof realFeatureNodeSchema>;
type RealEdge = z.infer<typeof realFeatureEdgeSchema>;
type GhostNode = z.infer<typeof ghostFeatureNodeSchema>;
type Annotation = z.infer<typeof annotationSchema>;
type NorthStar = z.infer<typeof northStarSchema>;

interface ScanResult {
  realNodes: RealNode[];
  realEdges: RealEdge[];
  warnings: string[];
}

interface CompassState {
  ghosts: GhostNode[];
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api.compass');
  return cachedLog;
}

function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

// ---------------------------------------------------------------------------
// Filesystem helpers — north star + state
// ---------------------------------------------------------------------------

function compassStateDir(repoPath: string): string {
  return join(repoPath, '.archon', 'state');
}

function compassStatePath(repoPath: string): string {
  return join(compassStateDir(repoPath), 'compass.json');
}

function northStarPath(repoPath: string): string {
  return join(repoPath, '.archon', 'north-star.yaml');
}

async function readNorthStar(repoPath: string): Promise<NorthStar | null> {
  const path = northStarPath(repoPath);
  try {
    const content = await readFile(path, 'utf-8');
    const parsed: unknown = Bun.YAML.parse(content);
    const result = northStarSchema.safeParse(parsed);
    if (!result.success) {
      getLog().warn(
        { path, errors: result.error.issues.map(i => i.message) },
        'compass.north_star_invalid'
      );
      return null;
    }
    return result.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLog().warn({ err: err as Error, path }, 'compass.north_star_read_failed');
    }
    return null;
  }
}

async function readCompassState(repoPath: string): Promise<CompassState> {
  const path = compassStatePath(repoPath);
  try {
    const content = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { ghosts?: unknown }).ghosts)
    ) {
      return { ghosts: (parsed as { ghosts: GhostNode[] }).ghosts };
    }
    return { ghosts: [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLog().warn({ err: err as Error, path }, 'compass.state_read_failed');
    }
    return { ghosts: [] };
  }
}

async function writeCompassState(repoPath: string, state: CompassState): Promise<void> {
  await mkdir(compassStateDir(repoPath), { recursive: true });
  await writeFile(compassStatePath(repoPath), JSON.stringify(state, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Codebase scanner — regex/glob-based v1
//
// Future upgrade path (v1.1): swap the regex passes for ts-morph AST parsing
// to extract exported symbols and an import graph. For v1 the goal is enough
// signal to populate a meaningful canvas — endpoints, UI routes, workflows,
// component groups — not a full call graph.
// ---------------------------------------------------------------------------

interface ScanCacheEntry {
  scannedAt: number;
  result: ScanResult;
}
const SCAN_CACHE = new Map<string, ScanCacheEntry>();
const SCAN_TTL_MS = 5 * 60_000;

async function getCachedScan(repoPath: string, force = false): Promise<ScanResult> {
  const now = Date.now();
  const cached = SCAN_CACHE.get(repoPath);
  if (!force && cached && now - cached.scannedAt < SCAN_TTL_MS) {
    return cached.result;
  }
  const result = await scanCodebase(repoPath);
  SCAN_CACHE.set(repoPath, { scannedAt: now, result });
  return result;
}

async function scanCodebase(repoPath: string): Promise<ScanResult> {
  const realNodes: RealNode[] = [];
  const realEdges: RealEdge[] = [];
  const warnings: string[] = [];
  await Promise.all([
    scanWorkflows(repoPath, realNodes, warnings),
    scanComponentGroups(repoPath, realNodes, warnings),
    scanApiEndpoints(repoPath, realNodes, warnings),
    scanUiRoutes(repoPath, realNodes, warnings),
  ]);
  return { realNodes, realEdges, warnings };
}

async function safeReaddir(
  path: string
): Promise<{ name: string; isDir: boolean; isFile: boolean }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function scanWorkflows(repoPath: string, out: RealNode[], warnings: string[]): Promise<void> {
  const dir = join(repoPath, '.archon', 'workflows');
  try {
    const entries = await safeReaddir(dir);
    for (const e of entries) {
      if (e.isFile && e.name.endsWith('.yaml')) {
        const name = e.name.replace(/\.yaml$/, '');
        out.push({
          id: `workflow:${name}`,
          kind: 'workflow',
          label: name,
          filePath: relative(repoPath, join(dir, e.name)),
        });
      } else if (e.isDir) {
        const sub = await safeReaddir(join(dir, e.name));
        for (const f of sub) {
          if (f.isFile && f.name.endsWith('.yaml')) {
            const name = `${e.name}/${f.name.replace(/\.yaml$/, '')}`;
            out.push({
              id: `workflow:${name}`,
              kind: 'workflow',
              label: name,
              filePath: relative(repoPath, join(dir, e.name, f.name)),
            });
          }
        }
      }
    }
  } catch (err) {
    warnings.push(`workflow scan: ${(err as Error).message}`);
  }
}

async function scanComponentGroups(
  repoPath: string,
  out: RealNode[],
  warnings: string[]
): Promise<void> {
  // Try monorepo paths (packages/*/src/components/) and single-package (src/components/).
  const candidates: string[] = [];
  try {
    const pkgEntries = await safeReaddir(join(repoPath, 'packages'));
    for (const e of pkgEntries) {
      if (e.isDir) candidates.push(join(repoPath, 'packages', e.name, 'src', 'components'));
    }
  } catch {
    /* not a monorepo */
  }
  candidates.push(join(repoPath, 'src', 'components'));

  for (const base of candidates) {
    try {
      const groups = await safeReaddir(base);
      for (const g of groups) {
        if (!g.isDir) continue;
        const files = await safeReaddir(join(base, g.name));
        const tsxCount = files.filter(f => f.isFile && f.name.endsWith('.tsx')).length;
        if (tsxCount === 0) continue;
        const groupRel = relative(repoPath, join(base, g.name));
        out.push({
          id: `component-group:${groupRel}`,
          kind: 'component',
          label: `${g.name} (${tsxCount})`,
          filePath: groupRel,
        });
      }
    } catch (err) {
      warnings.push(`component scan ${base}: ${(err as Error).message}`);
    }
  }
}

const ENDPOINT_RE = /\bpath:\s*['"`](\/api\/[^'"`]+)['"`]/g;

async function scanApiEndpoints(
  repoPath: string,
  out: RealNode[],
  warnings: string[]
): Promise<void> {
  const candidates: string[] = [];
  try {
    const pkgEntries = await safeReaddir(join(repoPath, 'packages'));
    for (const e of pkgEntries) {
      if (e.isDir) candidates.push(join(repoPath, 'packages', e.name, 'src', 'routes'));
    }
  } catch {
    /* not a monorepo */
  }
  candidates.push(join(repoPath, 'src', 'routes'));

  const seen = new Set<string>();
  for (const dir of candidates) {
    try {
      const files = await safeReaddir(dir);
      for (const f of files) {
        if (!f.isFile || !f.name.endsWith('.ts') || f.name.endsWith('.test.ts')) continue;
        const filePath = join(dir, f.name);
        try {
          const content = await readFile(filePath, 'utf-8');
          for (const match of content.matchAll(ENDPOINT_RE)) {
            const path = match[1];
            if (seen.has(path)) continue;
            seen.add(path);
            out.push({
              id: `endpoint:${path}`,
              kind: 'endpoint',
              label: path,
              filePath: relative(repoPath, filePath),
            });
          }
        } catch (err) {
          warnings.push(`endpoint read ${f.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      warnings.push(`endpoint scan ${dir}: ${(err as Error).message}`);
    }
  }
}

const UI_ROUTE_RE = /<Route\b[^>]*\bpath=\{?["'`]([^"'`]+)["'`]/g;

async function scanUiRoutes(repoPath: string, out: RealNode[], warnings: string[]): Promise<void> {
  // Scan App.tsx in any web package — that's where react-router routes live.
  const candidates: string[] = [];
  try {
    const pkgEntries = await safeReaddir(join(repoPath, 'packages'));
    for (const e of pkgEntries) {
      if (e.isDir) candidates.push(join(repoPath, 'packages', e.name, 'src', 'App.tsx'));
    }
  } catch {
    /* not a monorepo */
  }
  candidates.push(join(repoPath, 'src', 'App.tsx'));

  const seen = new Set<string>();
  for (const filePath of candidates) {
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      const content = await readFile(filePath, 'utf-8');
      for (const match of content.matchAll(UI_ROUTE_RE)) {
        const path = match[1];
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({
          id: `route:${path}`,
          kind: 'route',
          label: path,
          filePath: relative(repoPath, filePath),
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`ui-route scan: ${(err as Error).message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Annotation prompt + JSON Schema for output_format
// ---------------------------------------------------------------------------

const ANNOTATION_OUTPUT_SCHEMA = {
  type: 'object',
  required: [
    'drift_score',
    'north_star_alignment',
    'scope',
    'citations',
    'dependencies',
    'why_now',
  ],
  additionalProperties: false,
  properties: {
    drift_score: { type: 'number', minimum: 0, maximum: 10 },
    north_star_alignment: {
      type: 'object',
      additionalProperties: {
        type: 'string',
        enum: ['strengthens', 'weakens', 'neutral'],
      },
    },
    scope: { type: 'string', enum: ['1h', 'half-day', 'multi-day'] },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          lineStart: { type: 'integer', minimum: 0 },
          lineEnd: { type: 'integer', minimum: 0 },
          why: { type: 'string' },
        },
      },
    },
    dependencies: { type: 'array', items: { type: 'string' } },
    why_now: { type: 'string' },
  },
};

function buildAnnotationPrompt(
  ghost: GhostNode,
  scan: ScanResult,
  northStar: NorthStar | null
): string {
  const featureLines = scan.realNodes
    .map(n => `- [${n.kind}] ${n.label} @ ${n.filePath}`)
    .join('\n');
  const northStarText = northStar
    ? northStar.objectives
        .map(o => {
          const drift = o.examples_of_drift.length
            ? `\n  Drift examples: ${o.examples_of_drift.join(', ')}`
            : '';
          return `- ${o.id}: ${o.one_liner}${drift}`;
        })
        .join('\n')
    : '(none defined yet)';
  const objectiveIds = northStar ? northStar.objectives.map(o => o.id).join(', ') : '';

  return `You are a senior product engineer doing brownfield analysis of a codebase. A user has proposed a new feature. Score it against the existing code and the project's product north star. Be specific. Cite real files.

PROPOSED FEATURE
Title: ${ghost.title}${ghost.notes ? `\nNotes: ${ghost.notes}` : ''}

EXISTING CODEBASE (${scan.realNodes.length} extracted features)
${featureLines}

NORTH STAR
${northStarText}

Produce a JSON object matching the provided schema:
- drift_score (0-10): How much this would deviate from existing patterns and the north star. 0 = perfectly aligned, 10 = drastically off-course.
- north_star_alignment: For each objective id, one of strengthens / weakens / neutral. ${objectiveIds ? `Objective ids: ${objectiveIds}` : 'Empty object if no north star.'}
- scope: '1h' (trivial), 'half-day' (~4h), or 'multi-day'. If multi-day, mention in why_now that the proposal probably needs to be broken down.
- citations: 2-5 entries naming specific files from the EXISTING CODEBASE list. The "path" must match a real filePath shown above. Each "why" is one sentence.
- dependencies: Array of feature ids from the existing codebase (the part before " @ "). Only include features this would meaningfully touch.
- why_now: One sentence answering "why is this the right next thing to build?" — anchor to existing code or north-star alignment, not generic best practice.

Return ONLY the JSON object.`;
}

// ---------------------------------------------------------------------------
// Route configs
// ---------------------------------------------------------------------------

const getCompassGraphRoute = createRoute({
  method: 'get',
  path: '/api/compass/{codebaseId}/graph',
  tags: ['Compass'],
  summary: 'Fetch the compass graph for a codebase (real + ghosts + north star)',
  request: { params: compassCodebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: compassGraphResponseSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

const upsertCompassGhostRoute = createRoute({
  method: 'post',
  path: '/api/compass/{codebaseId}/ghosts',
  tags: ['Compass'],
  summary: 'Create or update a ghost feature node',
  request: {
    params: compassCodebaseIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: upsertGhostBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: upsertGhostResponseSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

const deleteCompassGhostRoute = createRoute({
  method: 'delete',
  path: '/api/compass/{codebaseId}/ghosts/{ghostId}',
  tags: ['Compass'],
  summary: 'Delete a ghost feature node',
  request: { params: compassGhostIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteGhostResponseSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase or ghost not found'),
    500: jsonError('Server error'),
  },
});

const annotateCompassGhostRoute = createRoute({
  method: 'post',
  path: '/api/compass/{codebaseId}/annotate',
  tags: ['Compass'],
  summary: 'Run AI annotation on a ghost (sync; returns full annotation)',
  request: {
    params: compassCodebaseIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: annotateGhostBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: annotateGhostResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    404: jsonError('Codebase or ghost not found'),
    500: jsonError('Server error'),
  },
});

const promoteCompassGhostRoute = createRoute({
  method: 'post',
  path: '/api/compass/{codebaseId}/promote',
  tags: ['Compass'],
  summary: 'Promote a ghost: queue locally, draft a GitHub issue, or kick off /workflow run plan',
  request: {
    params: compassCodebaseIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: promoteGhostBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: promoteGhostResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    404: jsonError('Codebase or ghost not found'),
    500: jsonError('Server error'),
  },
});

// ---------------------------------------------------------------------------
// Public registrar
// ---------------------------------------------------------------------------

export function registerCompassRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager
): void {
  function jsonRes(c: Context, status: 400 | 404 | 500, message: string): Response {
    return c.json({ error: message }, status);
  }

  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  registerOpenApiRoute(getCompassGraphRoute, async c => {
    const codebaseId = c.req.param('codebaseId') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (!codebase) return jsonRes(c, 404, 'Codebase not found');
      const cwd = codebase.default_cwd;
      const [scan, state, northStar] = await Promise.all([
        getCachedScan(cwd),
        readCompassState(cwd),
        readNorthStar(cwd),
      ]);
      const cacheEntry = SCAN_CACHE.get(cwd);
      return c.json(
        {
          realNodes: scan.realNodes,
          realEdges: scan.realEdges,
          ghostNodes: state.ghosts,
          northStar,
          lastScannedAt: cacheEntry ? new Date(cacheEntry.scannedAt).toISOString() : null,
          scanWarnings: scan.warnings,
        },
        200
      );
    } catch (err) {
      getLog().error({ err: err as Error, codebaseId }, 'compass.graph_failed');
      return jsonRes(c, 500, 'Failed to load compass graph');
    }
  });

  registerOpenApiRoute(upsertCompassGhostRoute, async c => {
    const codebaseId = c.req.param('codebaseId') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (!codebase) return jsonRes(c, 404, 'Codebase not found');
      const body = await c.req.json();
      const state = await readCompassState(codebase.default_cwd);
      const now = new Date().toISOString();
      let ghost: GhostNode;
      if (body.id) {
        const idx = state.ghosts.findIndex(g => g.id === body.id);
        if (idx === -1) {
          ghost = {
            id: body.id,
            title: body.title,
            notes: body.notes,
            position: body.position,
            status: 'draft',
            annotation: null,
            promoted_target: null,
            promoted_ref: null,
            created_at: now,
            updated_at: now,
          };
          state.ghosts.push(ghost);
        } else {
          const existing = state.ghosts[idx];
          ghost = {
            ...existing,
            title: body.title,
            notes: body.notes,
            position: body.position,
            updated_at: now,
          };
          state.ghosts[idx] = ghost;
        }
      } else {
        ghost = {
          id: randomUUID(),
          title: body.title,
          notes: body.notes,
          position: body.position,
          status: 'draft',
          annotation: null,
          promoted_target: null,
          promoted_ref: null,
          created_at: now,
          updated_at: now,
        };
        state.ghosts.push(ghost);
      }
      await writeCompassState(codebase.default_cwd, state);
      return c.json({ ghost }, 200);
    } catch (err) {
      getLog().error({ err: err as Error, codebaseId }, 'compass.upsert_ghost_failed');
      return jsonRes(c, 500, 'Failed to upsert ghost');
    }
  });

  registerOpenApiRoute(deleteCompassGhostRoute, async c => {
    const codebaseId = c.req.param('codebaseId') ?? '';
    const ghostId = c.req.param('ghostId') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (!codebase) return jsonRes(c, 404, 'Codebase not found');
      const state = await readCompassState(codebase.default_cwd);
      const before = state.ghosts.length;
      state.ghosts = state.ghosts.filter(g => g.id !== ghostId);
      if (state.ghosts.length === before) {
        return jsonRes(c, 404, 'Ghost not found');
      }
      await writeCompassState(codebase.default_cwd, state);
      return c.json({ deleted: true, id: ghostId }, 200);
    } catch (err) {
      getLog().error({ err: err as Error, codebaseId, ghostId }, 'compass.delete_ghost_failed');
      return jsonRes(c, 500, 'Failed to delete ghost');
    }
  });

  registerOpenApiRoute(annotateCompassGhostRoute, async c => {
    const codebaseId = c.req.param('codebaseId') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (!codebase) return jsonRes(c, 404, 'Codebase not found');
      const body = await c.req.json();
      const state = await readCompassState(codebase.default_cwd);
      const ghost = state.ghosts.find(g => g.id === body.ghostId);
      if (!ghost) return jsonRes(c, 404, 'Ghost not found');

      const [scan, northStar] = await Promise.all([
        getCachedScan(codebase.default_cwd),
        readNorthStar(codebase.default_cwd),
      ]);
      const prompt = buildAnnotationPrompt(ghost, scan, northStar);
      const provider = getAgentProvider(codebase.ai_assistant_type ?? 'claude');

      let raw = '';
      for await (const chunk of provider.sendQuery(prompt, codebase.default_cwd, undefined, {
        nodeConfig: { allowed_tools: [], output_format: ANNOTATION_OUTPUT_SCHEMA },
      })) {
        if (chunk.type === 'assistant') raw += chunk.content;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        const match = /\{[\s\S]*\}/.exec(raw);
        if (!match) {
          getLog().error({ raw }, 'compass.annotation_unparseable');
          return jsonRes(c, 500, 'AI returned unparseable annotation');
        }
        parsed = JSON.parse(match[0]);
      }

      const annotationFields = annotationSchema.omit({ generated_at: true }).safeParse(parsed);
      if (!annotationFields.success) {
        getLog().error(
          { raw, errors: annotationFields.error.issues.map(i => i.message) },
          'compass.annotation_invalid'
        );
        return jsonRes(c, 500, 'AI returned annotation in unexpected shape');
      }
      const annotation: Annotation = {
        ...annotationFields.data,
        generated_at: new Date().toISOString(),
      };

      ghost.annotation = annotation;
      ghost.updated_at = new Date().toISOString();
      await writeCompassState(codebase.default_cwd, state);

      return c.json({ ghost, annotation }, 200);
    } catch (err) {
      getLog().error({ err: err as Error, codebaseId }, 'compass.annotate_failed');
      return jsonRes(c, 500, `Failed to annotate: ${(err as Error).message}`);
    }
  });

  registerOpenApiRoute(promoteCompassGhostRoute, async c => {
    const codebaseId = c.req.param('codebaseId') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (!codebase) return jsonRes(c, 404, 'Codebase not found');
      const body = await c.req.json();
      const state = await readCompassState(codebase.default_cwd);
      const ghost = state.ghosts.find(g => g.id === body.ghostId);
      if (!ghost) return jsonRes(c, 404, 'Ghost not found');

      const now = new Date().toISOString();
      let issueUrl: string | null = null;
      let conversationId: string | null = null;

      if (body.target === 'queue') {
        ghost.status = 'queued';
        ghost.promoted_target = 'queue';
        ghost.promoted_ref = null;
      } else if (body.target === 'issue') {
        const title = ghost.title;
        const bodyText = renderIssueBody(ghost);
        try {
          const result = await execFileAsync(
            'gh',
            ['issue', 'create', '--title', title, '--body', bodyText],
            { cwd: codebase.default_cwd, timeout: 30_000 }
          );
          issueUrl = result.stdout.trim().split('\n').pop() ?? null;
          ghost.status = 'promoted';
          ghost.promoted_target = 'issue';
          ghost.promoted_ref = issueUrl;
        } catch (err) {
          getLog().error(
            { err: err as Error, codebaseId, ghostId: ghost.id },
            'compass.promote_issue_failed'
          );
          return jsonRes(c, 500, `Failed to create GitHub issue: ${(err as Error).message}`);
        }
      } else if (body.target === 'workflow') {
        const platformConvId = `compass-plan-${ghost.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const conv = await conversationDb.getOrCreateConversation(
          'web',
          platformConvId,
          codebaseId
        );
        await conversationDb.updateConversation(conv.id, {
          cwd: codebase.default_cwd,
          codebase_id: codebaseId,
        });
        webAdapter.setConversationDbId(platformConvId, conv.id);
        const message = `/workflow run plan ${ghost.title}${ghost.notes ? `\n\nNotes: ${ghost.notes}` : ''}`;
        // Fire-and-forget: the workflow runs async, the UI navigates to /chat?conv=...
        void lockManager
          .acquireLock(platformConvId, async () => {
            await handleMessage(webAdapter, platformConvId, message, {
              isolationHints: { workflowType: 'thread', workflowId: platformConvId },
            });
          })
          .catch((e: unknown) => {
            getLog().error(
              { err: e, conversationId: platformConvId },
              'compass.promote_workflow_dispatch_failed'
            );
          });
        ghost.status = 'promoted';
        ghost.promoted_target = 'workflow';
        ghost.promoted_ref = platformConvId;
        conversationId = platformConvId;
      } else {
        return jsonRes(c, 400, `Unknown promote target: ${String(body.target)}`);
      }

      ghost.updated_at = now;
      await writeCompassState(codebase.default_cwd, state);

      return c.json({ ghost, issueUrl, conversationId }, 200);
    } catch (err) {
      getLog().error({ err: err as Error, codebaseId }, 'compass.promote_failed');
      return jsonRes(c, 500, `Failed to promote: ${(err as Error).message}`);
    }
  });
}

function renderIssueBody(ghost: GhostNode): string {
  const a = ghost.annotation;
  const lines: string[] = [];
  if (ghost.notes) {
    lines.push(ghost.notes, '');
  }
  if (a) {
    lines.push(`**Why now:** ${a.why_now}`, '');
    lines.push(`**Scope:** ${a.scope}`, '');
    lines.push(`**Drift score:** ${a.drift_score}/10`, '');
    if (Object.keys(a.north_star_alignment).length) {
      lines.push('**North-star alignment:**');
      for (const [obj, alignment] of Object.entries(a.north_star_alignment)) {
        lines.push(`- ${obj}: ${alignment}`);
      }
      lines.push('');
    }
    if (a.dependencies.length) {
      lines.push('**Touches:**');
      for (const dep of a.dependencies) lines.push(`- \`${dep}\``);
      lines.push('');
    }
    if (a.citations.length) {
      lines.push('**File citations:**');
      for (const cite of a.citations) {
        const range = cite.lineStart && cite.lineEnd ? `:${cite.lineStart}-${cite.lineEnd}` : '';
        lines.push(`- \`${cite.path}${range}\` — ${cite.why}`);
      }
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('Drafted from Compass.');
  return lines.join('\n');
}
