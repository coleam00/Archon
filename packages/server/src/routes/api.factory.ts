/**
 * Read-only routes for the console's Software Factory section. Nothing here writes: the
 * section reads the engine's own records, the factory view and overview files packs and
 * projects ship (`@archon/workflows/factory-views`, `factory-overviews`), a pack's declared
 * settings and each project's values for them (`factory-pack-settings`), and asks the change
 * host whether a change merged through the forge seam.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { isAbsolute } from 'node:path';
import type { Context } from 'hono';
import {
  type ChangeLookup,
  type ChangeMergeState,
  prRefFromAudits,
} from '@archon/adapters/forge-host';
import {
  FactoryRunFactsMemo,
  readFactoryItem,
  readFactoryProgress,
  type FactoryChangeLookup,
  type FactoryChangeRecord,
  type FactoryChangeState,
} from '@archon/workflows/factory-items';
import {
  readFactoryDiscoveries,
  type DiscoveriesSource,
} from '@archon/workflows/factory-discoveries';
import { ITEM_WINDOW_MAX_LIMIT } from '@archon/workflows/item-window';
import {
  discoverFactoryOverviews,
  resolveFactoryPacks,
  type FactoryPackProject,
} from '@archon/workflows/factory-overviews';
import {
  discoverFactoryViews,
  factoryPackIsInstalled,
  factoryRunWorkflowName,
  factoryViewWorkflowNames,
  factoryViewsForProject,
} from '@archon/workflows/factory-views';
import {
  findPackDeclaration,
  readFactoryPackSettings,
  type FactoryPackSettings,
} from '@archon/workflows/factory-pack-settings';
import { factoryWorkflowSteps } from '@archon/workflows/factory-steps';
import type { WorkflowConfig } from '@archon/workflows/deps';
import type { ItemReadSource } from '@archon/workflows/item-read';
import type { FactoryPacks } from '@archon/workflows/schemas/factory-overview';
import type { FactoryViewsListing } from '@archon/workflows/schemas/factory-view';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { liveSourceRoots, workflowSourceConfigFrom } from '@archon/workflows/workflow-source';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  factoryDiscoveriesResponseSchema,
  factoryItemDetailResponseSchema,
  factoryPackSettingsResponseSchema,
  factoryPacksResponseSchema,
  factoryProgressResponseSchema,
  factoryViewsSchema,
  factoryWorkflowSchema,
} from './schemas/factory.schemas';

const factoryViewsQuerySchema = z.object({
  codebaseId: z
    .string()
    .min(1)
    .openapi({ description: 'The project whose factory views to list.' }),
});

const getFactoryViewsRoute = createRoute({
  method: 'get',
  path: '/api/factory/views',
  tags: ['Workflows'],
  summary: 'The factory views that apply to a project',
  description:
    'A view applies when the project ships its own `.archon/packs/<pack key>.factory-view.json`, or when a pack declares one and the project has run a workflow the view names. Declarations that could not be read or did not validate are listed under `errors` with their file.',
  request: { query: factoryViewsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: factoryViewsSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

const getFactoryPacksRoute = createRoute({
  method: 'get',
  path: '/api/factory/packs',
  tags: ['Workflows'],
  summary: 'Every pack with a factory overview, and the projects that run it',
  description:
    "The hand-written explainers of how each pack's factory runs, across the install: the pack's own `.shared/factory-overview.json` first, else the first project (by name) shipping `.archon/packs/<pack key>.factory-overview.json`, named in `readFrom`. A pack whose files are all broken is listed with a null `overview` and its `errors`. `projects` are the projects a factory view of the pack applies to. A project that could not be read is listed under `unreadProjects`; the other packs still list.",
  responses: {
    200: {
      content: { 'application/json': { schema: factoryPacksResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const factoryPackSettingsQuerySchema = z.object({
  pack: z
    .string()
    .min(1)
    .openapi({ description: "The pack's key, as `GET /api/factory/packs` lists it." }),
});

const getFactoryPackSettingsRoute = createRoute({
  method: 'get',
  path: '/api/factory/pack-settings',
  tags: ['Workflows'],
  summary: "A pack's declared settings, and what each project that runs it sets",
  description:
    'Every setting the pack declares in its `.pack/pack.yaml` (`inputs:`), in its order, presented as the `settings` map of the overview `GET /api/factory/packs` shows for it says (shadow, and whether the value names a policy or the checks file). For each project a factory view of the pack applies to: its value of each setting from `.archon/packs/<pack key>.yaml`, the file a policy or checks setting names looked up in its checkout (a checks file listed), and the keys it sets that the pack does not declare. A map key the pack does not declare is listed under `mapErrors`. A project whose settings file cannot be read carries its `error`; the others still read. Nothing is written.',
  request: { query: factoryPackSettingsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: factoryPackSettingsResponseSchema } },
      description: 'OK',
    },
    404: jsonError('No pack with a factory overview has this key'),
    500: jsonError('Server error'),
  },
});

const factoryDiscoveriesQuerySchema = z.object({
  codebaseId: z
    .string()
    .min(1)
    .openapi({ description: 'The project whose discoveries drains to read.' }),
});

const getFactoryDiscoveriesRoute = createRoute({
  method: 'get',
  path: '/api/factory/discoveries',
  tags: ['Workflows'],
  summary: "What a project's discoveries drains decided to file",
  description:
    "Every finding the completed runs of the workflow the first applying factory view's `discoveries` field names decided to file, newest first, with how many they held and dropped, read at the pointers that field declares. `shadow` says the drains only decide what they would file. A finding's `coveredBy` names an item on the project with the same title (case-insensitive), null while none has it. A drain whose result has no decisions at those pointers counts under `unreadable`.",
  request: { query: factoryDiscoveriesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: factoryDiscoveriesResponseSchema } },
      description: 'OK',
    },
    404: jsonError(
      'Codebase not found, no factory view applies to it, or it declares no discoveries'
    ),
    500: jsonError('Server error'),
  },
});

const factoryProgressQuerySchema = z.object({
  codebaseId: z.string().min(1).openapi({ description: 'The project the items belong to.' }),
  keys: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(ITEM_WINDOW_MAX_LIMIT)])
    .openapi({
      description:
        "The items' keys, as `GET /api/items` takes them: repeat `keys` once per item, up to a page of `GET /api/items/window`.",
    }),
});

const getFactoryProgressRoute = createRoute({
  method: 'get',
  path: '/api/factory/progress',
  tags: ['Workflows'],
  summary: "The board progress of a project's items, by key",
  description:
    'What the board needs of each item that its read (`GET /api/items/window`) does not carry, derived through the first factory view that applies to the project (`pack` names it): the running step, its check rounds (the iterations of a declared loop, or one round per run of a declared stage-form workflow, numbered by its result), how often a return point sent it back, its title, the work order the declared `partOf` result names, the newest decision of each shadow step the view declares (`shadows`: what it would have done; nothing acted on it), and its change, with whether that merged: merged as the engine recorded it when the item carries a merge record (`archon workflow merged`, or a land run), and the change host is then not asked whether it merged (only, once and in the background, for a pull request number no audit row of its runs names, which fills a later read); else as the change host reports it (cached on the server; `pending` when the server is still asking it, so read again shortly). `members` lists, for each asked item, the items with an active `part_of` link to it. A key may name an item with no runs (a work order); a key the project has no item under is left out; an item whose progress could not be derived reads null.',
  request: { query: factoryProgressQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: factoryProgressResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Invalid query'),
    404: jsonError('Codebase not found, or no factory view applies to it'),
    500: jsonError('Server error'),
  },
});

const factoryWorkflowQuerySchema = z.object({
  codebaseId: z.string().min(1).openapi({ description: 'The project whose factory view to read.' }),
  workflow: z
    .string()
    .min(1)
    .openapi({ description: "A workflow a factory view's stage names, as the view names it." }),
});

const getFactoryWorkflowRoute = createRoute({
  method: 'get',
  path: '/api/factory/workflow',
  tags: ['Workflows'],
  summary: "One workflow's steps, as a factory view draws them",
  description:
    "The steps of a workflow a factory view applying to the project names, from the definition runs execute: each step keyed as run events name it, the loop groups and included workflows that frame it, its kind, declared model, `when:`, the prompt it runs and the YAML its author wrote. The first applying view whose stages name the workflow says which pack's workflow it is.",
  request: { query: factoryWorkflowQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: factoryWorkflowSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase, view or workflow not found'),
    500: jsonError('Server error'),
  },
});

const factoryItemQuerySchema = z.object({
  codebaseId: z.string().min(1).openapi({ description: 'The project the item belongs to.' }),
  key: z
    .string()
    .min(1)
    .openapi({ description: "The item's key in the project, as `GET /api/items` takes it." }),
});

const getFactoryItemRoute = createRoute({
  method: 'get',
  path: '/api/factory/item',
  tags: ['Workflows'],
  summary: 'One item with its progress and the story facts of each of its runs',
  description:
    "The item's read, as `GET /api/items` returns it, with its `progress` as `GET /api/factory/progress` reads it, plus `runs`: for each of the item's runs, in the item read's order, the workflow as the view declares it, the run's cost, its running step while it runs, its check rounds (a declared loop's iterations, or the run's one round when its workflow is a stage-form rounds source) with the steps that recorded an outcome in each, what each shadow step the view declares decided on that run (`shadows`, one per completed step and round, in recording order; a run of the discoveries workflow included), the pull request the run named at the view's `change` pointer (`change`), what it said in its own words at the view's `story.said` pointers (`said`), the models its steps ran on (`models`), and when each of its steps started (`steps`, as the engine records the step id).",
  request: { query: factoryItemQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: factoryItemDetailResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Invalid query'),
    404: jsonError('Codebase not found, no factory view applies to it, or no such item'),
    500: jsonError('Server error'),
  },
});

/** The merge state of one change, as the forge seam answered it (`changeMergeState`). */
type ChangeMergeLookup = (
  lookup: ChangeLookup,
  branches: () => Promise<readonly string[]>
) => Promise<ChangeMergeState>;

export interface FactoryRouteDeps {
  /**
   * A registered codebase's checkout, the engine's project key for it, and its registered git
   * remote (null when it has none); null when the codebase is unknown.
   */
  codebase: (
    id: string
  ) => Promise<{ cwd: string; projectKey: string; remote: string | null } | null>;
  /** Every registered codebase, for the reads that span the install. */
  codebases: () => Promise<readonly { id: string; name: string; cwd: string }[]>;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  /** Which of these run names (as runs record them) the codebase has any run of. */
  ranWorkflows: (codebaseId: string, names: readonly string[]) => Promise<ReadonlySet<string>>;
  itemsSource: ItemReadSource;
  /** Reads every item of a project for the discoveries route. */
  discoveriesSource: DiscoveriesSource;
  changeMergeState: ChangeMergeLookup;
  /** Workflow discovery for a project, as runs see it. */
  discoverWorkflows: (cwd: string) => Promise<WorkflowLoadResult>;
  /** How long one read waits on a lookup no request has made yet; tests shorten it. */
  changeStateWaitMs?: number;
  now?: () => number;
}

/**
 * One load in flight per key, the last success kept with the time it settled. The caller owns
 * freshness. A load that rejects stores nothing and rejects its callers.
 */
function keyedOnce<T, A extends unknown[]>(
  load: (key: string, ...args: A) => Promise<T>,
  now: () => number
): {
  known: (key: string) => { value: T; at: number } | undefined;
  refresh: (key: string, ...args: A) => Promise<T>;
} {
  const kept = new Map<string, { value: T; at: number }>();
  const running = new Map<string, Promise<T>>();
  return {
    known: key => kept.get(key),
    refresh: (key, ...args) => {
      const inFlight = running.get(key);
      if (inFlight !== undefined) return inFlight;
      const started = load(key, ...args)
        .then(value => {
          kept.set(key, { value, at: now() });
          return value;
        })
        .finally(() => running.delete(key));
      running.set(key, started);
      return started;
    },
  };
}

/** How long a change that has not merged keeps its answer. A merge does not come undone. */
const CHANGE_STATE_TTL_MS = 60_000;
/**
 * A forge read retries temporary failures for about 7 s; a read answers before that and
 * the lookup finishes into the cache for the next one.
 */
const CHANGE_STATE_WAIT_MS = 4_000;

type ChangeAnswer = Awaited<ReturnType<ChangeMergeLookup>>;
/** What a read answers: the host's answer, or `pending` while its lookup still runs. */
type ShownAnswer = Awaited<ReturnType<FactoryChangeState>>;
/** The change state of the project whose remote a branch lookup searches. */
type ProjectChangeState = (
  lookup: FactoryChangeLookup,
  branches: () => Promise<readonly string[]>,
  remote: string | null,
  recorded: FactoryChangeRecord | null
) => ReturnType<FactoryChangeState>;

/**
 * The change host's answer for each change, shared by every request. An item whose merge the
 * engine recorded answers merged at the recorded time at once: a merge does not come undone,
 * so after a restart such an item needs no lookup to be placed or counted. Its change is asked
 * about only when no audit row names its pull request, once, in the background, for the
 * number alone (`recordedAnswer`). Otherwise:
 * one lookup in flight per change, a merged answer kept, any other for
 * `CHANGE_STATE_TTL_MS`. A change is keyed by its URL, or, for a run that named no URL, by
 * that run, so two such items never share an answer. A stale answer is served while its
 * refresh runs. A cold lookup slower than the wait answers `pending` for that request only
 * and is never cached, so the next read gets the host's answer once it settles; a lookup
 * that failed answers `unknown` and is cached like any other. The URL is the run's, else the
 * forge's (the record's, when recorded); the pull request number is the forge's, else the
 * one the run's own audit rows name, so a `pending` or recorded answer still carries it when
 * they do.
 */
export function changeStateCache(
  deps: Pick<FactoryRouteDeps, 'changeMergeState' | 'changeStateWaitMs' | 'now'>
): ProjectChangeState {
  const now = deps.now ?? Date.now;
  const waitMs = deps.changeStateWaitMs ?? CHANGE_STATE_WAIT_MS;
  const keyOf = (change: FactoryChangeLookup): string =>
    change.kind === 'url' ? change.url : `run:${change.run}`;
  const answers = keyedOnce(
    (
      key: string,
      change: FactoryChangeLookup,
      branches: () => Promise<readonly string[]>,
      remote: string | null
    ): Promise<ChangeAnswer> => {
      const asked: ChangeLookup = change.kind === 'url' ? change : { kind: 'branch', remote };
      return deps
        .changeMergeState(asked, branches)
        .catch(
          (error: unknown): ChangeAnswer => ({
            url: null,
            merged: 'unknown',
            mergedAt: null,
            number: null,
            reason: (error as Error).message,
          })
        )
        .then(answer => {
          if (answer.merged === 'unknown')
            getLog().warn({ change: key, reason: answer.reason }, 'factory_change_state_unknown');
          return answer;
        });
    },
    now
  );
  const lookup = (
    change: FactoryChangeLookup,
    branches: () => Promise<readonly string[]>,
    remote: string | null
  ): Promise<ChangeAnswer> => answers.refresh(keyOf(change), change, branches, remote);
  const shown = (answer: ShownAnswer, change: FactoryChangeLookup): ShownAnswer =>
    change.kind === 'url'
      ? {
          url: change.url,
          merged: answer.merged,
          mergedAt: answer.mergedAt,
          number: answer.number ?? prRefFromAudits(change.url, change.audits)?.number ?? null,
        }
      : {
          url: answer.url,
          merged: answer.merged,
          mergedAt: answer.mergedAt,
          number: answer.number,
        };
  /**
   * A recorded merge, answered at once: merged at the recorded time, placed and counted
   * without the change host. Only the pull request number can be missing (no audit row of the
   * run names it); then the host is asked once per process, in the background, and its number
   * fills later reads when its pull request is the one shown. Nothing waits on that lookup.
   */
  const recordedAnswer = (
    change: FactoryChangeLookup,
    branches: () => Promise<readonly string[]>,
    remote: string | null,
    recorded: FactoryChangeRecord
  ): ShownAnswer => {
    const answer = shown(
      { url: recorded.change, merged: true, mergedAt: recorded.at, number: null },
      change
    );
    if (answer.number !== null) return answer;
    const known = answers.known(keyOf(change));
    if (known === undefined) {
      void lookup(change, branches, remote);
      return answer;
    }
    return known.value.url === answer.url ? { ...answer, number: known.value.number } : answer;
  };
  return async (change, branches, remote, recorded) => {
    if (recorded !== null) return recordedAnswer(change, branches, remote, recorded);
    const known = answers.known(keyOf(change));
    if (known !== undefined) {
      if (known.value.merged !== true && now() - known.at >= CHANGE_STATE_TTL_MS)
        void lookup(change, branches, remote);
      return shown(known.value, change);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only `answers.refresh` writes the cache, so this answer never outlives the request.
    const waited = new Promise<ShownAnswer>(resolve => {
      timer = setTimeout(() => {
        resolve({ url: null, merged: 'pending', mergedAt: null, number: null });
      }, waitMs);
    });
    const answer: ShownAnswer = await Promise.race([lookup(change, branches, remote), waited]);
    clearTimeout(timer);
    return shown(answer, change);
  };
}

/** How long the stage graph serves a project's discovered workflows before refreshing them. */
const DISCOVERY_FRESH_MS = 30_000;

/** A project's workflows for the stage graph; `fresh` waits on a new discovery. */
type StageDiscovery = (cwd: string, options?: { fresh?: boolean }) => Promise<WorkflowLoadResult>;

/**
 * Workflow discovery for a stage's step graph, kept per project checkout. A discovery
 * parses every workflow the project can see, about a second on the live factory, and the
 * graph only displays what it finds. So one discovery runs per checkout at a time, shared by
 * every read; a result younger than `DISCOVERY_FRESH_MS` is served as it is, and an older one
 * is served once more while a refresh runs. So a workflow edited on disk reaches the graph on
 * the second read made `DISCOVERY_FRESH_MS` or more after the discovery it replaces: the first
 * starts the refresh and gets the old steps. That is acceptable for a read-only drawing (the
 * page holds its graph until a reload anyway); runs and `/api/workflows` discover for
 * themselves and never read this. A failed discovery is never kept: the first one rejects its
 * reads, and a failed refresh is logged and the last result stays.
 */
export function discoveryCache(
  deps: Pick<FactoryRouteDeps, 'discoverWorkflows' | 'now'>
): StageDiscovery {
  const now = deps.now ?? Date.now;
  const found = keyedOnce((cwd: string) => deps.discoverWorkflows(cwd), now);
  const discover = (cwd: string): Promise<WorkflowLoadResult> => found.refresh(cwd);
  return async (cwd, { fresh = false } = {}) => {
    const entry = found.known(cwd);
    if (entry === undefined || fresh) return discover(cwd);
    if (now() - entry.at >= DISCOVERY_FRESH_MS)
      discover(cwd).catch((error: unknown) => {
        getLog().warn({ err: error, cwd }, 'factory_workflow_discovery_refresh_failed');
      });
    return entry.value;
  };
}

type ProjectRoots = ReturnType<typeof liveSourceRoots>;

/** The live source roots of the project checked out at `cwd`, under its config. */
async function projectRoots(deps: FactoryRouteDeps, cwd: string): Promise<ProjectRoots> {
  return liveSourceRoots(cwd, workflowSourceConfigFrom(await deps.loadConfig(cwd)));
}

/**
 * The factory views that apply to the project read through `roots`. Every factory route
 * reads them here, so they cannot disagree about which view applies.
 */
async function applyingViews(
  deps: FactoryRouteDeps,
  codebaseId: string,
  roots: ProjectRoots
): Promise<FactoryViewsListing> {
  const listing = await discoverFactoryViews(roots);
  const ran = await deps.ranWorkflows(codebaseId, factoryViewWorkflowNames(listing));
  return factoryViewsForProject(listing, ran);
}

type ApplyingView = FactoryViewsListing['views'][number];

/**
 * Why `workflow`, which a stage of `view` lists, cannot be drawn, for the person reading the
 * stage or step page. The pack is known to be here when `found` holds another workflow of it
 * that the view lists and has not retired; then only this workflow is missing.
 */
function missingWorkflowMessage(
  view: ApplyingView,
  workflow: string,
  found: WorkflowLoadResult
): string {
  const { pack, declaration } = view;
  const retired = declaration.retired ?? [];
  if (retired.includes(workflow))
    return `This pack has no workflow named ${workflow}. It was retired; the items it worked still show their runs.`;
  const names = new Set(found.workflows.map(entry => entry.workflow.name));
  const packHere = declaration.stages
    .flatMap(stage => stage.workflows)
    .some(listed => !retired.includes(listed) && names.has(factoryRunWorkflowName(pack, listed)));
  if (packHere) return `This pack has no workflow named ${workflow}.`;
  return factoryPackIsInstalled(pack)
    ? `The pack ${pack} is not installed here, so its workflow ${workflow} cannot be drawn. Install it with the command archon plugin add, then reload this page.`
    : `The pack ${pack} has no workflow ${workflow} in this project, so it cannot be drawn.`;
}

/** The discoveries of the first applying view, as the Factory tab draws its pack. */
async function discoveriesResponse(
  c: Context,
  deps: FactoryRouteDeps,
  codebaseId: string,
  project: { cwd: string; projectKey: string }
): Promise<Response> {
  const roots = await projectRoots(deps, project.cwd);
  const [view] = (await applyingViews(deps, codebaseId, roots)).views;
  if (view === undefined) return apiError(c, 404, 'No factory view applies to this project');
  if (view.declaration.discoveries === undefined)
    return apiError(c, 404, 'This factory view declares no discoveries');
  const read = await readFactoryDiscoveries(deps.discoveriesSource, {
    view: view.declaration,
    pack: view.pack,
    projectKey: project.projectKey,
    onUnreadable: runId => {
      getLog().warn({ codebaseId, runId }, 'factory_discoveries_unreadable');
    },
  });
  return c.json(read);
}

/**
 * Every pack with an overview across the install: the home scopes read once with no
 * project, then each registered project's own files and applying views.
 */
async function factoryPacks(deps: FactoryRouteDeps): Promise<FactoryPacks> {
  const home = await discoverFactoryOverviews(liveSourceRoots(null));
  const projects = await Promise.all(
    (await deps.codebases()).map(async ({ id, name, cwd }): Promise<FactoryPackProject> => {
      try {
        if (!isAbsolute(cwd)) throw new Error(`its checkout path "${cwd}" is not absolute`);
        const roots = await projectRoots(deps, cwd);
        const listing = await discoverFactoryOverviews(roots);
        const views = (await applyingViews(deps, id, roots)).views;
        return { codebaseId: id, name, listing, viewPacks: views.map(view => view.pack) };
      } catch (error) {
        getLog().warn({ err: error, codebaseId: id }, 'factory_pack_project_unreadable');
        return { codebaseId: id, name, error: (error as Error).message };
      }
    })
  );
  return resolveFactoryPacks({ home, projects });
}

/**
 * The Settings page of the pack keyed `key`, or null when no pack with an overview has that
 * key. The declaration is the install's (bundled, global or installed), else the first
 * project's, by name, whose checkout holds the pack as a folder.
 */
async function packSettings(
  deps: FactoryRouteDeps,
  key: string
): Promise<FactoryPackSettings | null> {
  const pack = (await factoryPacks(deps)).packs.find(listed => listed.key === key);
  if (pack === undefined) return null;
  const cwds = new Map((await deps.codebases()).map(({ id, cwd }) => [id, cwd]));
  const projects = pack.projects.flatMap(({ codebaseId, name }) => {
    const cwd = cwds.get(codebaseId);
    return cwd === undefined ? [] : [{ codebaseId, name, cwd }];
  });
  let declaration = await findPackDeclaration(liveSourceRoots(null), key);
  for (const project of projects) {
    if (declaration !== null) break;
    declaration = await findPackDeclaration(await projectRoots(deps, project.cwd), key);
  }
  return readFactoryPackSettings({
    packKey: key,
    declaration,
    map: pack.overview?.declaration.settings,
    sections: pack.overview?.declaration.setting_sections,
    projects,
  });
}

export function registerFactoryRoutes(app: OpenAPIHono, deps: FactoryRouteDeps): void {
  const register = openApiRouteRegistrar(app);
  const changeStates = changeStateCache(deps);
  const stageWorkflows = discoveryCache(deps);
  const memo = new FactoryRunFactsMemo();

  register(getFactoryViewsRoute, async c => {
    const { codebaseId } = getValidatedQuery(c, factoryViewsQuerySchema);
    const project = await deps.codebase(codebaseId);
    if (project === null) return apiError(c, 404, 'Codebase not found');
    try {
      const roots = await projectRoots(deps, project.cwd);
      const applying = await applyingViews(deps, codebaseId, roots);
      // The body lists these too; the log keeps them findable without a console open.
      for (const { pack, path, error } of applying.errors)
        getLog().warn({ codebaseId, pack, path, error }, 'factory_view_invalid');
      return c.json(applying);
    } catch (error) {
      getLog().error({ err: error, codebaseId }, 'discover_factory_views_failed');
      return apiError(c, 500, 'Failed to discover factory views');
    }
  });

  register(getFactoryPacksRoute, async c => {
    try {
      const packs = await factoryPacks(deps);
      for (const { pack, path, error } of [...packs.errors, ...packs.packs.flatMap(p => p.errors)])
        getLog().warn({ pack, path, error }, 'factory_overview_invalid');
      return c.json(packs);
    } catch (error) {
      getLog().error({ err: error }, 'discover_factory_packs_failed');
      return apiError(c, 500, 'Failed to discover the factory packs');
    }
  });

  register(getFactoryPackSettingsRoute, async c => {
    const { pack } = getValidatedQuery(c, factoryPackSettingsQuerySchema);
    try {
      const read = await packSettings(deps, pack);
      if (read === null) return apiError(c, 404, 'No factory pack has this key');
      // The body lists these too; the log keeps them findable without a console open.
      if (read.declaration?.error)
        getLog().warn({ pack, path: read.declaration.path }, 'factory_pack_declaration_invalid');
      for (const error of read.mapErrors)
        getLog().warn({ pack, error }, 'factory_pack_settings_map_invalid');
      for (const { codebaseId, error } of read.projects)
        if (error !== null)
          getLog().warn({ pack, codebaseId }, 'factory_pack_project_settings_invalid');
      return c.json(read);
    } catch (error) {
      getLog().error({ err: error, pack }, 'factory_pack_settings_read_failed');
      return apiError(c, 500, "Failed to read the pack's settings");
    }
  });

  register(getFactoryDiscoveriesRoute, async c => {
    const { codebaseId } = getValidatedQuery(c, factoryDiscoveriesQuerySchema);
    const project = await deps.codebase(codebaseId);
    if (project === null) return apiError(c, 404, 'Codebase not found');
    try {
      return await discoveriesResponse(c, deps, codebaseId, project);
    } catch (error) {
      getLog().error({ err: error, codebaseId }, 'factory_discoveries_read_failed');
      return apiError(c, 500, 'Failed to read what the discoveries drains decided');
    }
  });

  register(getFactoryItemRoute, async c => {
    const { codebaseId, key } = getValidatedQuery(c, factoryItemQuerySchema);
    const project = await deps.codebase(codebaseId);
    if (project === null) return apiError(c, 404, 'Codebase not found');
    try {
      // The view the progress route reads, so an item reads here as it does on the board.
      const roots = await projectRoots(deps, project.cwd);
      const [view] = (await applyingViews(deps, codebaseId, roots)).views;
      if (view === undefined) return apiError(c, 404, 'No factory view applies to this project');
      const detail = await readFactoryItem(
        deps.itemsSource,
        {
          view: view.declaration,
          pack: view.pack,
          projectKey: project.projectKey,
          changeState: (change, branches, recorded) =>
            changeStates(change, branches, project.remote, recorded),
          memo,
          onProgressError: (itemId, error) => {
            getLog().error({ err: error, codebaseId, itemId }, 'factory_item_progress_failed');
          },
        },
        key
      );
      if (detail === null) return apiError(c, 404, 'No such item in this project');
      return c.json(detail);
    } catch (error) {
      getLog().error({ err: error, codebaseId }, 'factory_item_read_failed');
      return apiError(c, 500, 'Failed to read the factory item');
    }
  });

  register(getFactoryProgressRoute, async c => {
    const { codebaseId, keys } = getValidatedQuery(c, factoryProgressQuerySchema);
    const project = await deps.codebase(codebaseId);
    if (project === null) return apiError(c, 404, 'Codebase not found');
    try {
      // The first view, as the console's Factory tab draws it; `pack` says which.
      const roots = await projectRoots(deps, project.cwd);
      const [view] = (await applyingViews(deps, codebaseId, roots)).views;
      if (view === undefined) return apiError(c, 404, 'No factory view applies to this project');
      const progress = await readFactoryProgress(
        deps.itemsSource,
        {
          view: view.declaration,
          pack: view.pack,
          projectKey: project.projectKey,
          changeState: (change, branches, recorded) =>
            changeStates(change, branches, project.remote, recorded),
          memo,
          onProgressError: (itemId, error) => {
            getLog().error({ err: error, codebaseId, itemId }, 'factory_item_progress_failed');
          },
        },
        typeof keys === 'string' ? [keys] : keys
      );
      return c.json(progress);
    } catch (error) {
      getLog().error({ err: error, codebaseId }, 'factory_progress_read_failed');
      return apiError(c, 500, 'Failed to read the factory progress');
    }
  });

  register(getFactoryWorkflowRoute, async c => {
    const { codebaseId, workflow } = getValidatedQuery(c, factoryWorkflowQuerySchema);
    const project = await deps.codebase(codebaseId);
    if (project === null) return apiError(c, 404, 'Codebase not found');
    try {
      const roots = await projectRoots(deps, project.cwd);
      const view = (await applyingViews(deps, codebaseId, roots)).views.find(candidate =>
        candidate.declaration.stages.some(stage => stage.workflows.includes(workflow))
      );
      if (view === undefined)
        return apiError(c, 404, `This factory has no stage that runs the workflow ${workflow}.`);
      const runName = factoryRunWorkflowName(view.pack, workflow);
      const named = (
        found: WorkflowLoadResult
      ): WorkflowLoadResult['workflows'][number] | undefined =>
        found.workflows.find(candidate => candidate.workflow.name === runName);
      // A kept discovery may predate installing the pack, and the 404 below may tell the person
      // to install it and reload: discover again before saying it is missing.
      let found = await stageWorkflows(project.cwd);
      if (named(found) === undefined) found = await stageWorkflows(project.cwd, { fresh: true });
      const entry = named(found);
      // Said for the person reading the stage, who can act on it.
      if (entry === undefined)
        return apiError(c, 404, missingWorkflowMessage(view, workflow, found));
      return c.json(
        await factoryWorkflowSteps(workflow, entry.workflow, { cwd: project.cwd, deps, roots })
      );
    } catch (error) {
      getLog().error({ err: error, codebaseId, workflow }, 'read_factory_workflow_failed');
      return apiError(c, 500, 'Failed to read the workflow');
    }
  });
}
