/**
 * `GET /api/forge/subjects`: what the project's forge says of its issues and of the changes runs
 * delivered, through Archon's forge seam (`@archon/adapters/forge-host`). An item has no title
 * column and a merge on the forge is no run event, so a reader that shows an issue's title or
 * whether a change merged asks here. The browser never calls the forge. It changes nothing on
 * the forge or in the engine; its answers are also kept in a display cache file under the
 * server's home (`forge-answer-file.ts`), so a restarted server does not ask again per card.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import {
  type ChangeLookup,
  type ChangeMergeState,
  prRefFromAudits,
  type WorkItemAnswer,
} from '@archon/adapters/forge-host';
import type { IWorkflowStore } from '@archon/workflows/store';
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import type { ForgeAnswerFile, Kept } from './forge-answer-file';

/** The most issues, and the most changes, one request asks about. */
const SUBJECTS_MAX = 100;

const repeated = (description: string) =>
  z
    .union([z.string().min(1), z.array(z.string().min(1)).max(SUBJECTS_MAX)])
    .optional()
    .openapi({ description });

const forgeSubjectsQuerySchema = z.object({
  codebaseId: z.string().min(1).openapi({ description: 'The project whose forge to ask.' }),
  issue: repeated('An issue number in the project remote; repeat once per issue.'),
  changeRun: repeated(
    'A run that delivered a change at a URL; repeat once per change, paired by position with `changeUrl`.'
  ),
  changeUrl: repeated('The URL the `changeRun` at the same position delivered.'),
  branchRun: repeated(
    "A run that delivered a change but named no URL: its item's run branches are searched for the pull request."
  ),
});

const mergedSchema = z.union([z.boolean(), z.literal('unknown'), z.literal('pending')]);

export const forgeSubjectsResponseSchema = z
  .object({
    /** One entry per issue asked. Null fields while the forge has not answered, or could not. */
    issues: z.array(
      z.object({
        number: z.number().int().positive(),
        title: z.string().nullable(),
        state: z.enum(['open', 'closed']).nullable(),
        url: z.string().nullable(),
        /** The forge is still being asked; read again shortly. Never cached. */
        pending: z.boolean(),
      })
    ),
    /**
     * One entry per change asked, by the run that delivered it. A `branchRun` whose item
     * recorded no branch and no merge has no change and no entry.
     */
    changes: z.array(
      z.object({
        run: z.string(),
        /** The change's URL; null only while the forge has not named the pull request. */
        url: z.string().nullable(),
        merged: mergedSchema,
        mergedAt: z.string().nullable(),
        number: z.number().int().positive().nullable(),
      })
    ),
  })
  .meta({ id: 'ForgeSubjects' });

const getForgeSubjectsRoute = createRoute({
  method: 'get',
  path: '/api/forge/subjects',
  tags: ['Workflows'],
  summary: "What the project's forge says of some issues and delivered changes",
  description:
    "Each issue's title, state and URL, and for each change a run delivered: its URL, pull request number and whether it merged. A change whose item recorded a merge (a land run, or `archon workflow merged`) is merged at the recorded time without asking the forge. Otherwise answers are cached on the server, in memory and in a file under its home so a restarted server keeps them (a change that has not merged for 60 s, an issue for 6 h and an issue the forge could not read for 10 min, a stale answer served while it refreshes); a first lookup slower than a few seconds answers `pending` (a change) or `pending: true` (an issue) for that read only, so read again shortly.",
  request: { query: forgeSubjectsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: forgeSubjectsResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Invalid query'),
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

/** The merge the engine recorded on an item: the change it names and when it merged. */
interface RecordedMerge {
  change: string;
  at: string;
}

/** What the route reads of a run that delivered a change. */
export interface DeliveredRun {
  /** The run's forge audit rows, which may name the pull request its URL is. */
  audits: readonly unknown[];
  /** The branches the run's item's runs recorded, newest-started first. */
  branches: () => Promise<readonly string[]>;
  /** The merge recorded on the run's item; null when none is, or its row is unreadable. */
  recorded: RecordedMerge | null;
}

export interface ForgeRouteDeps {
  /** A registered codebase's git remote (null when it has none); undefined when the codebase is unknown. */
  remote: (codebaseId: string) => Promise<string | null | undefined>;
  /** What the route reads of a run; null when there is no such run. */
  deliveredRun: (runId: string) => Promise<DeliveredRun | null>;
  changeMergeState: (
    lookup: ChangeLookup,
    branches: () => Promise<readonly string[]>
  ) => Promise<ChangeMergeState>;
  viewWorkItem: (number: number, remote: string | null) => Promise<WorkItemAnswer>;
  /** How long one read waits on a lookup no request has made yet; tests shorten it. */
  waitMs?: number;
  now?: () => number;
  /**
   * The file the answers are kept in across restarts (`forgeAnswerFile`); without it they
   * live only as long as the process.
   */
  answerFile?: ForgeAnswerFile;
}

/** Where a cache keeps its answers, and who hears of a new one. */
interface Keeping<T> {
  kept?: Map<string, Kept<T>>;
  onKept?: () => void;
}

/**
 * One load in flight per key, the last success kept with the time it settled. The caller owns
 * freshness. A load that rejects stores nothing and rejects its callers.
 */
function keyedOnce<T, A extends unknown[]>(
  load: (key: string, ...args: A) => Promise<T>,
  now: () => number,
  { kept = new Map<string, Kept<T>>(), onKept }: Keeping<T> = {}
): {
  known: (key: string) => { value: T; at: number } | undefined;
  refresh: (key: string, ...args: A) => Promise<T>;
} {
  const running = new Map<string, Promise<T>>();
  return {
    known: key => kept.get(key),
    refresh: (key, ...args) => {
      const inFlight = running.get(key);
      if (inFlight !== undefined) return inFlight;
      const started = load(key, ...args)
        .then(value => {
          kept.set(key, { value, at: now() });
          onKept?.();
          return value;
        })
        .finally(() => running.delete(key));
      running.set(key, started);
      return started;
    },
  };
}

/**
 * `promise`'s value, or `pending` when it has not settled after `waitMs`. The promise still
 * settles into its cache, so the next read gets it.
 */
async function within<T, P>(promise: Promise<T>, waitMs: number, pending: P): Promise<T | P> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<P>(resolve => {
    timer = setTimeout(() => {
      resolve(pending);
    }, waitMs);
  });
  const answer = await Promise.race([promise, waited]);
  clearTimeout(timer);
  return answer;
}

/** How long a change that has not merged keeps its answer. A merge does not come undone. */
const CHANGE_TTL_MS = 60_000;
/**
 * How long an issue's answer is kept before a read refreshes it. Cards show only an issue's
 * title, which rarely changes, and refreshing means one forge plugin process per issue: with
 * a ten-minute TTL, a page load after a pause refreshed every titleless card and slowed the server
 * for about a minute.
 */
const ISSUE_TTL_MS = 6 * 3600_000;
/**
 * How long a failed issue lookup is kept: long enough that a read does not ask again on every
 * page load, short enough that a forge blip (an auth lapse, a rate limit) does not leave a card
 * titleless for `ISSUE_TTL_MS`.
 */
const ISSUE_FAILURE_TTL_MS = 10 * 60_000;
/**
 * A forge read retries temporary failures for about 7 s; a read answers before that and
 * the lookup finishes into the cache for the next one.
 */
const WAIT_MS = 4_000;
/** The most issue lookups in flight at once, so a cold read of every item does not flood the forge. */
const ISSUE_LOOKUPS = 8;
/**
 * The most refreshes of a stale issue in flight at once. A stale answer is already shown, and
 * a restarted server finds every answer its file kept stale: each lookup runs a forge plugin
 * process, and eight at a time slowed every other read of the first page load.
 */
const ISSUE_REFRESHES = 2;

/** `work`, with at most `most` of the works given to one limiter running at once. */
function limiter(most: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: (() => void)[] = [];
  return async work => {
    if (running >= most) await new Promise<void>(resolve => queue.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}

/** A change to ask about: a URL with its run's audit rows, or the pull request on a run's item's branches. */
type Change =
  | { kind: 'url'; url: string; audits: readonly unknown[] }
  | { kind: 'branch'; run: string };
type ChangeAnswer = z.infer<typeof forgeSubjectsResponseSchema>['changes'][number];
type ShownAnswer = Omit<ChangeAnswer, 'run'>;

/**
 * The forge's answer for each change, shared by every request. A change whose item recorded
 * its merge answers merged at the recorded time at once; it is asked about only when no audit
 * row names its pull request, once, without waiting, for the number alone. Otherwise one
 * lookup in flight per change, a merged answer kept, any other for `CHANGE_TTL_MS` and served
 * stale while it refreshes. A cold lookup slower than the wait answers `pending` for that
 * request only; a lookup that failed answers `unknown` and is cached like any other. A change
 * is keyed by its URL, or, for a run that named none, by that run, so two such items never
 * share an answer. The URL is the run's, else the forge's (the record's, when recorded); the
 * number is the forge's, else the one the run's own audit rows name.
 */
export function changeStateCache(
  deps: Pick<ForgeRouteDeps, 'changeMergeState' | 'waitMs' | 'now'>,
  keeping: Keeping<ChangeMergeState> = {}
): (
  change: Change,
  branches: () => Promise<readonly string[]>,
  remote: string | null,
  recorded: RecordedMerge | null
) => Promise<ShownAnswer> {
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? WAIT_MS;
  const keyOf = (change: Change): string =>
    change.kind === 'url' ? change.url : `run:${change.run}`;
  const answers = keyedOnce(
    (
      key: string,
      change: Change,
      branches: () => Promise<readonly string[]>,
      remote: string | null
    ): Promise<ChangeMergeState> => {
      const asked: ChangeLookup = change.kind === 'url' ? change : { kind: 'branch', remote };
      return deps
        .changeMergeState(asked, branches)
        .catch(
          (error: unknown): ChangeMergeState => ({
            url: null,
            merged: 'unknown',
            mergedAt: null,
            number: null,
            reason: (error as Error).message,
          })
        )
        .then(answer => {
          if (answer.merged === 'unknown')
            getLog().warn({ change: key, reason: answer.reason }, 'forge_change_state_unknown');
          return answer;
        });
    },
    now,
    keeping
  );
  const lookup = (
    change: Change,
    branches: () => Promise<readonly string[]>,
    remote: string | null
  ): Promise<ChangeMergeState> => answers.refresh(keyOf(change), change, branches, remote);
  const shown = (answer: ShownAnswer, change: Change): ShownAnswer =>
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
  const recordedAnswer = (
    change: Change,
    branches: () => Promise<readonly string[]>,
    remote: string | null,
    recorded: RecordedMerge
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
      if (known.value.merged !== true && now() - known.at >= CHANGE_TTL_MS)
        void lookup(change, branches, remote);
      return shown(known.value, change);
    }
    const pending: ShownAnswer = { url: null, merged: 'pending', mergedAt: null, number: null };
    return shown(await within(lookup(change, branches, remote), waitMs, pending), change);
  };
}

type IssueAnswer = z.infer<typeof forgeSubjectsResponseSchema>['issues'][number];

/**
 * The forge's answer for each issue, shared by every request: kept `ISSUE_TTL_MS` and served
 * stale while it refreshes. A failure is kept `ISSUE_FAILURE_TTL_MS`, so an issue that cannot
 * be read is not asked again on every read but is asked again soon. At most `ISSUE_LOOKUPS` first lookups and `ISSUE_REFRESHES`
 * refreshes run at once. A cold lookup slower than the wait answers `pending` for that request
 * only.
 */
function issueCache(
  deps: Pick<ForgeRouteDeps, 'viewWorkItem' | 'waitMs' | 'now'>,
  keeping: Keeping<WorkItemAnswer> = {}
): (number: number, remote: string | null) => Promise<IssueAnswer> {
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? WAIT_MS;
  const lookups = limiter(ISSUE_LOOKUPS);
  const refreshes = limiter(ISSUE_REFRESHES);
  const answers = keyedOnce(
    (key: string, number: number, remote: string | null, stale: boolean): Promise<WorkItemAnswer> =>
      (stale ? refreshes : lookups)(() => deps.viewWorkItem(number, remote)).then(answer => {
        if ('unknown' in answer)
          getLog().warn({ issue: key, reason: answer.unknown }, 'forge_issue_unknown');
        return answer;
      }),
    now,
    keeping
  );
  const shown = (answer: WorkItemAnswer): IssueAnswer =>
    'unknown' in answer
      ? { number: answer.number, title: null, state: null, url: null, pending: false }
      : { ...answer, pending: false };
  return async (number, remote) => {
    const key = `${remote ?? ''}#${String(number)}`;
    const known = answers.known(key);
    if (known !== undefined) {
      const life = 'unknown' in known.value ? ISSUE_FAILURE_TTL_MS : ISSUE_TTL_MS;
      if (now() - known.at >= life) void answers.refresh(key, number, remote, true);
      return shown(known.value);
    }
    const pending = { number, title: null, state: null, url: null, pending: true } as const;
    const answer = await within(answers.refresh(key, number, remote, false), waitMs, pending);
    return 'pending' in answer ? answer : shown(answer);
  };
}

/**
 * `ForgeRouteDeps.deliveredRun` over the engine's store: the run's `integration_operation`
 * rows, its item's recorded merge, and the branches `branchOf` finds for its item's own runs.
 */
export function deliveredRunFrom(
  store: Pick<
    IWorkflowStore,
    'getWorkflowRun' | 'listEventsForRuns' | 'getItem' | 'getItemMerge' | 'getItemRuns'
  >,
  branchOf: (run: WorkflowRun) => Promise<string | null>
): ForgeRouteDeps['deliveredRun'] {
  return async runId => {
    const run = await store.getWorkflowRun(runId);
    if (run === null) return null;
    const rows = (await store.listEventsForRuns([runId], ['integration_operation'])).get(runId);
    const item = run.item_id === null ? null : await store.getItem(run.item_id);
    // An unreadable merge row reads as none: the forge is asked, and the item read's own
    // `degraded` reports the row.
    const merge = item === null ? null : await store.getItemMerge(item.id);
    return {
      audits: (rows ?? []).map(row => row.data),
      recorded: merge === null || 'type' in merge ? null : { change: merge.change, at: merge.at },
      branches: async () => {
        const found = item === null ? null : await store.getItemRuns(item.projectKey, item.key);
        const runs = splitAttentionRead(found?.runs ?? []).values.sort(
          (a, b) => b.started_at.getTime() - a.started_at.getTime()
        );
        const branches = await Promise.all(runs.map(each => branchOf(each)));
        return [...new Set(branches.filter((branch): branch is string => branch !== null))];
      },
    };
  };
}

const listOf = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : value;

export function registerForgeRoutes(app: OpenAPIHono, deps: ForgeRouteDeps): void {
  const register = openApiRouteRegistrar(app);
  const file = deps.answerFile ?? null;
  const changeStates = changeStateCache(
    deps,
    file === null ? {} : { kept: file.changes, onKept: file.changed }
  );
  const issues = issueCache(deps, file === null ? {} : { kept: file.issues, onKept: file.changed });

  /** The answer for one delivered change; null when its run is gone, or it has no change. */
  const answerFor = async (
    run: string,
    url: string | null,
    remote: string | null
  ): Promise<ChangeAnswer | null> => {
    const delivered = await deps.deliveredRun(run);
    if (delivered === null) return null;
    const { audits, branches, recorded } = delivered;
    if (url !== null)
      return {
        run,
        ...(await changeStates({ kind: 'url', url, audits }, branches, remote, recorded)),
      };
    // An item that has not reached delivery on any branch never asks the forge.
    const heads = await branches();
    if (heads.length === 0)
      return recorded === null
        ? null
        : { run, url: recorded.change, merged: true, mergedAt: recorded.at, number: null };
    return {
      run,
      ...(await changeStates({ kind: 'branch', run }, async () => heads, remote, recorded)),
    };
  };

  register(getForgeSubjectsRoute, async c => {
    const query = getValidatedQuery(c, forgeSubjectsQuerySchema);
    const numbers = listOf(query.issue).map(Number);
    if (numbers.some(n => !Number.isInteger(n) || n <= 0))
      return apiError(c, 400, 'An issue is a positive whole number');
    const changeRuns = listOf(query.changeRun);
    const changeUrls = listOf(query.changeUrl);
    if (changeRuns.length !== changeUrls.length)
      return apiError(c, 400, 'Every changeRun needs the changeUrl at the same position');
    try {
      // Read once, on the first request: registering the route reads nothing.
      await file?.load();
      const remote = await deps.remote(query.codebaseId);
      if (remote === undefined) return apiError(c, 404, 'Codebase not found');
      const [issueAnswers, changes] = await Promise.all([
        Promise.all([...new Set(numbers)].map(n => issues(n, remote))),
        Promise.all([
          ...changeRuns.map((run, i) => answerFor(run, changeUrls[i] ?? null, remote)),
          ...listOf(query.branchRun).map(run => answerFor(run, null, remote)),
        ]),
      ]);
      return c.json({
        issues: issueAnswers,
        changes: changes.filter((answer): answer is ChangeAnswer => answer !== null),
      });
    } catch (error) {
      getLog().error({ err: error, codebaseId: query.codebaseId }, 'forge_subjects_read_failed');
      return apiError(c, 500, 'Failed to read what the forge says');
    }
  });
}
