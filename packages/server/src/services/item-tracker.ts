/**
 * The item tracker: one more destination for what the engine records about an item. For
 * each tracked project it keeps one status comment per item on the item's tracker
 * subject, edited in place when a run on the item starts or ends, and posts a new comment
 * once for each question, ask and ruling, and for the final result. It reads only engine
 * records and never reads a comment back.
 *
 * Like the attention router it polls durable facts instead of subscribing to the
 * in-process emitter: a run a CLI process ends never reaches this server's emitter, and a
 * poll with a durable ledger catches up after a restart.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, getPluginsPath } from '@archon/paths';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import {
  forgeOperationAuditSchema,
  repoRefSchema,
  temporaryErrorKinds,
  type ForgeResponse,
  type ForgeSubjectRef,
  type RepoRef,
} from '@archon/forge';
import { checkForgeAccess, dispatchForge, type ForgeAccessCheck } from '@archon/forge/dispatch';
import { readForgeConfig, sourceForgePlugins } from '@archon/forge/host-plugins';
import { forgePluginConfigSchema } from '@archon/forge/plugin-config';
import type { ItemTrackerConfig, TrackedProject } from '@archon/core/config/config-types';
import { getDatabase } from '@archon/core/db/connection';
import { listItemAsks } from '@archon/core/db/item-asks';
import { listItemRulings } from '@archon/core/db/item-rulings';
import { getItemRuns } from '@archon/core/db/items';
import {
  listTrackerCandidateRuns,
  listTrackerItemsOwingComments,
  listTrackerLedger,
  listTrackerResultsOwed,
  recordTrackerBaseline,
  runEndStageOwed,
  TRACKER_RESULT_KEY,
  trackerAskKey,
  trackerRulingKey,
  trackerStatusKey,
  type TrackerCandidateRun,
  type TrackerRow,
} from '@archon/core/db/item-tracker';
import {
  hasAnyAttentionNotice,
  listEventsForRuns,
  persistWorkflowEvent,
} from '@archon/core/db/workflow-events';
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import { isTerminalRunStatus } from '@archon/workflows/schemas/run-status';
import { runAttention, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { PushDestinationState } from './attention-router';
import {
  ITEM_STATUS_MARKER,
  questionKey,
  renderAsk,
  renderItemStatus,
  renderQuestion,
  renderResult,
  renderRuling,
  trackerSubject,
  type TrackerComment,
} from './item-tracker-render';

const UPSERT_OPERATION = 'workitem.comment.upsert';

/** The forge plugin contract as the tracker uses it. Production binds it to `@archon/forge/dispatch`. */
export interface ItemTrackerForge {
  check(request: { host: string; operations: readonly string[] }): Promise<ForgeAccessCheck>;
  upsertComment(request: {
    operationId: string;
    op: typeof UPSERT_OPERATION;
    subject: ForgeSubjectRef;
    marker: string;
    body: string;
  }): Promise<ForgeResponse>;
}

/**
 * The forge as `archon forge` reaches it: the `forge:` block of the Archon config, the
 * installed plugins and, from a source checkout, the bundled GitHub plugin. The config is
 * read once, on first use.
 */
export function hostItemTrackerForge(env: NodeJS.ProcessEnv = process.env): ItemTrackerForge {
  let options: Promise<Parameters<typeof dispatchForge>[1]> | undefined;
  const discovery = (): Promise<Parameters<typeof dispatchForge>[1]> => {
    options ??= (async () => {
      const archonHome = getArchonHome(env);
      return {
        config: forgePluginConfigSchema.parse(
          await readForgeConfig(getArchonConfigPath(archonHome))
        ),
        env,
        credentialEnv: env,
        pluginsDir: getPluginsPath(archonHome),
        sourcePlugins: sourceForgePlugins(),
      };
    })();
    return options;
  };
  return {
    check: async request => checkForgeAccess(request, await discovery()),
    upsertComment: async request => (await dispatchForge(request, await discovery())).response,
  };
}

type TrackerState = Extract<PushDestinationState, 'active' | 'misconfigured'>;

interface Tracked {
  project: TrackedProject;
  destination: string;
  repo?: RepoRef;
  state: TrackerState;
  /** The destination has a ledger row, so a restart does not baseline it again. */
  anchored: boolean;
}

function itemTrackerDestinationId(projectKey: string): string {
  return `tracker:${projectKey}`;
}

export class ItemTracker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = true;
  private readonly log = createLogger('server.item-tracker');
  private readonly tracked: Tracked[];
  /** Writes the forge refused for good; not retried before a restart, so a bad key costs one call. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly config: ItemTrackerConfig,
    private readonly forge: ItemTrackerForge
  ) {
    // A project starts misconfigured and becomes active only once `activate` has checked
    // its plugin and committed its baseline.
    this.tracked = config.projects.map(project => ({
      project,
      destination: itemTrackerDestinationId(project.project),
      state: 'misconfigured',
      anchored: false,
    }));
  }

  /** Check each project's forge plugin once, and baseline a project's first activation. */
  async activate(): Promise<void> {
    for (const tracked of this.tracked) {
      const problem = await this.checkProject(tracked);
      if (problem) {
        this.log.error(
          { project: tracked.project.project, ...problem },
          'item_tracker.misconfigured'
        );
        continue;
      }
      if (!(await hasAnyAttentionNotice(tracked.destination))) {
        const pauses = await openQuestionRows(tracked);
        await getDatabase().withTransaction(query =>
          recordTrackerBaseline(tracked.project.project, tracked.destination, query, pauses)
        );
      }
      tracked.anchored = await hasAnyAttentionNotice(tracked.destination);
      tracked.state = 'active';
    }
  }

  private async checkProject(
    tracked: Tracked
  ): Promise<{ errorKind: string; unsupported?: string[] } | undefined> {
    const repo = repoRefSchema.safeParse(tracked.project.repo);
    if (!repo.success) return { errorKind: 'invalid_repo' };
    tracked.repo = repo.data;
    let check: ForgeAccessCheck;
    try {
      check = await this.forge.check({ host: repo.data.host, operations: [UPSERT_OPERATION] });
    } catch (err) {
      this.log.error({ err, project: tracked.project.project }, 'item_tracker.check_failed');
      return { errorKind: 'check_failed' };
    }
    if (check.ok) return undefined;
    return {
      errorKind: check.error.kind,
      ...(check.unsupported ? { unsupported: check.unsupported } : {}),
    };
  }

  health(): { id: string; state: TrackerState }[] {
    return this.tracked.map(tracked => ({ id: tracked.destination, state: tracked.state }));
  }

  scan(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    for (const tracked of this.tracked)
      if (tracked.state === 'active' && tracked.repo) await this.scanProject(tracked, tracked.repo);
  }

  /**
   * Each item that may owe a write: one with a live run (it may have paused), a run whose
   * status comment does not show its current state, an ask or ruling not yet posted, or
   * a final result not yet posted.
   */
  private async scanProject(tracked: Tracked, repo: RepoRef): Promise<void> {
    const projectKey = tracked.project.project;
    const candidates = await listTrackerCandidateRuns(projectKey, tracked.destination);
    await this.anchor(tracked, candidates);
    const owed = new Map<string, TrackerCandidateRun[]>();
    for (const run of candidates)
      if (!run.shown) owed.set(run.itemKey, [...(owed.get(run.itemKey) ?? []), run]);
    const owingComments = await listTrackerItemsOwingComments(projectKey, tracked.destination);
    const owingResults = (await listTrackerResultsOwed(projectKey, tracked.destination)).map(
      owing => owing.itemKey
    );
    const live = candidates.filter(run => !run.terminal).map(run => run.itemKey);
    for (const itemKey of new Set([...owed.keys(), ...owingComments, ...owingResults, ...live])) {
      const subject = trackerSubject(tracked.project, repo, itemKey);
      const owedRuns = owed.get(itemKey) ?? [];
      if (subject) await this.writeItem(tracked, itemKey, subject, owedRuns);
      else if (
        owedRuns.length > 0 ||
        owingComments.includes(itemKey) ||
        owingResults.includes(itemKey)
      )
        await this.settleUnmapped(tracked, itemKey, owedRuns);
    }
  }

  /**
   * The project's first ledger row is what tells a restart the tracker was already on,
   * so the activation baseline runs once. A first activation with nothing to baseline
   * records that row on the first run the tracker sees, before any write can fail.
   */
  private async anchor(
    tracked: Tracked,
    candidates: readonly TrackerCandidateRun[]
  ): Promise<void> {
    const first = candidates[0];
    if (tracked.anchored || !first) return;
    await this.record(tracked, { runId: first.id, key: 'activated' }, true);
    tracked.anchored = true;
  }

  /**
   * An item with no tracker subject gets nothing. Its ended runs, results, asks and
   * rulings are recorded as shown, so the scan stays bounded and adding a key rule later
   * cannot post on them.
   */
  private async settleUnmapped(
    tracked: Tracked,
    itemKey: string,
    owedRuns: readonly TrackerCandidateRun[]
  ): Promise<void> {
    const facts = await itemFacts(tracked, itemKey);
    const rows: TrackerRow[] = [
      ...owedRuns
        .filter(run => run.terminal)
        .map(run => ({ runId: run.id, key: trackerStatusKey('terminal', run.resumes) })),
      ...(facts ? facts.comments.map(comment => comment.row) : []),
    ];
    for (const row of rows) await this.record(tracked, row, true);
    // Read after the status rows, which the result is owed from.
    const owed = await this.resultOwed(tracked, itemKey);
    if (owed) await this.record(tracked, { runId: owed, key: TRACKER_RESULT_KEY }, true);
  }

  private async resultOwed(tracked: Tracked, itemKey: string): Promise<string | undefined> {
    const [owed] = await listTrackerResultsOwed(
      tracked.project.project,
      tracked.destination,
      itemKey
    );
    return owed?.runId;
  }

  /**
   * Write what the item's tracker subject is owed: the status comment when a run's state
   * changed, a new comment for each question, ask and ruling not posted yet, and the
   * result when the work is over. The result is owed from the status rows, so it is read
   * after they are recorded, and stays owed until it is posted.
   */
  private async writeItem(
    tracked: Tracked,
    itemKey: string,
    subject: ForgeSubjectRef,
    owedRuns: readonly TrackerCandidateRun[]
  ): Promise<void> {
    const facts = await itemFacts(tracked, itemKey);
    if (!facts) return;
    const { itemId, runs, comments } = facts;
    const write = (comment: TrackerComment): Promise<boolean> =>
      this.writeComment(tracked, itemId, subject, comment);
    if (owedRuns.length > 0) {
      const body = renderItemStatus(
        runs,
        facts.unreadableRuns,
        await proposedChange(runs.map(run => run.id)),
        this.config.includeUsage
      );
      if (!(await write({ marker: ITEM_STATUS_MARKER, body }))) return;
      await this.recordShown(tracked, owedRuns, runs);
    }
    for (const { comment, row } of comments)
      if (await write(comment)) await this.record(tracked, row);
    if ((await this.resultOwed(tracked, itemKey)) === undefined) return;
    // Read again: a run can start, end and open an ask while the writes above are awaited.
    const current = await itemFacts(tracked, itemKey);
    const result = current && (await finalResult(current));
    if (!current || !result) return;
    const change = await proposedChange(current.runs.map(run => run.id));
    if (await write(renderResult(result, change, this.config.includeUsage)))
      await this.record(tracked, { runId: result.id, key: TRACKER_RESULT_KEY });
  }

  /**
   * Record the state the status comment showed each owed run in, naming the resume count
   * the candidate read saw. That read came before the comment's, so a resume it missed
   * leaves the row naming an earlier end and the run owed. An unreadable run, which the
   * comment cannot show, is recorded in the state the candidate read saw so it is not
   * retried.
   */
  private async recordShown(
    tracked: Tracked,
    owedRuns: readonly TrackerCandidateRun[],
    runs: readonly WorkflowRun[]
  ): Promise<void> {
    const statuses = new Map(runs.map(run => [run.id, run.status] as const));
    for (const run of owedRuns) {
      const status = statuses.get(run.id);
      const terminal = status === undefined ? run.terminal : isTerminalRunStatus(status);
      const key = trackerStatusKey(terminal ? 'terminal' : 'started', run.resumes);
      await this.record(tracked, { runId: run.id, key });
    }
  }

  /** A baseline row records a fact as shown without anything having been written. */
  private async record(tracked: Tracked, row: TrackerRow, baseline = false): Promise<void> {
    await persistWorkflowEvent({
      workflow_run_id: row.runId,
      event_type: 'attention_notice_sent',
      data: { destination: tracked.destination, key: row.key, ...(baseline ? { baseline } : {}) },
    });
  }

  /** Upsert one marked comment; false when it was not written. */
  private async writeComment(
    tracked: Tracked,
    itemId: string,
    subject: ForgeSubjectRef,
    comment: TrackerComment
  ): Promise<boolean> {
    const write = `${tracked.destination}|${subject.kind}:${String(subject.ref.number)}|${comment.marker}`;
    if (this.refused.has(write)) return false;
    const response = await this.upsert(tracked, subject, comment);
    if (!response.ok) {
      this.reportFailure(tracked, itemId, write, response);
      return false;
    }
    this.log.info({ destination: tracked.destination, itemId }, 'item_tracker.comment_written');
    return true;
  }

  private async upsert(
    tracked: Tracked,
    subject: ForgeSubjectRef,
    { marker, body }: TrackerComment
  ): Promise<ForgeResponse> {
    const operationId = randomUUID();
    try {
      return await this.forge.upsertComment({
        operationId,
        op: UPSERT_OPERATION,
        subject,
        marker,
        body,
      });
    } catch (err) {
      // A dispatch that throws wrote nothing the tracker can know about; the next scan retries.
      this.log.error({ err, destination: tracked.destination }, 'item_tracker.dispatch_failed');
      return {
        operationId,
        ok: false,
        error: { kind: 'process_failed', message: 'forge dispatch threw' },
      };
    }
  }

  /**
   * A write that failed is retried on the next scan. One the forge refused for good, such
   * as a key naming an issue that does not exist, is not retried until a restart. The
   * upsert's marker makes a retry after an unknown outcome safe: it edits, never posts twice.
   */
  private reportFailure(
    tracked: Tracked,
    itemId: string,
    write: string,
    response: Extract<ForgeResponse, { ok: false }>
  ): void {
    const outcome = response.mutation?.outcome ?? 'refused';
    const temporary = (temporaryErrorKinds as readonly string[]).includes(response.error.kind);
    const settled = outcome === 'refused' && !temporary && response.error.kind !== 'process_failed';
    if (settled) this.refused.add(write);
    this.log.error(
      {
        destination: tracked.destination,
        itemId,
        op: UPSERT_OPERATION,
        outcome,
        errorKind: response.error.kind,
        retried: !settled,
      },
      'item_tracker.write_failed'
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      try {
        await this.scan();
      } catch (err) {
        this.log.error({ err }, 'item_tracker.scan_failed');
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          void tick();
        }, 5000);
        this.timer.unref();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.scanning;
  }
}

interface OwedComment {
  comment: TrackerComment;
  row: TrackerRow;
}

interface ItemFacts {
  itemId: string;
  runs: WorkflowRun[];
  /** Runs on the item that could not be read; the status comment cannot show them. */
  unreadableRuns: number;
  openAsks: StoredItemAsk[];
  /** An ask on the item could not be read, so whether it is open is unknown. */
  unreadableAsk: boolean;
  /** The question, ask and ruling comments not posted yet. */
  comments: OwedComment[];
}

const postedKey = (row: TrackerRow): string => `${row.runId}|${row.key}`;

/** What the item holds that its tracker shows: its readable runs, asks, rulings and ledger. */
async function itemFacts(tracked: Tracked, itemKey: string): Promise<ItemFacts | undefined> {
  const found = await getItemRuns(tracked.project.project, itemKey);
  if (!found) return undefined;
  const { values: runs, degraded: unreadable } = splitAttentionRead(found.runs);
  const [asks, rulings] = await Promise.all([
    listItemAsks(found.item.id),
    listItemRulings(found.item.id),
  ]);
  const readAsks = splitAttentionRead(asks);
  const openAsks = readAsks.values.filter(ask => ask.closed === null);
  const ledger = await listTrackerLedger(
    [...new Set([...runs.map(run => run.id), ...openAsks.map(ask => ask.runId)])],
    tracked.destination
  );
  const posted = new Set(ledger.map(postedKey));
  const comments: OwedComment[] = [
    ...questionComments(runs),
    ...openAsks.map(ask => ({
      comment: renderAsk(ask),
      row: { runId: ask.runId, key: trackerAskKey(ask.id) },
    })),
  ].filter(owed => !posted.has(postedKey(owed.row)));
  // A ruling is shown once the item has a run, and its row is recorded on one; the
  // baseline picks that run in SQL, so a posted ruling is found on any of them.
  const postedKeys = new Set(ledger.map(row => row.key));
  const anchor = runs[0]?.id;
  if (anchor !== undefined)
    for (const ruling of rulings) {
      if ('type' in ruling || ruling.withdrawn !== null) continue;
      const key = trackerRulingKey(ruling.id);
      if (!postedKeys.has(key))
        comments.push({ comment: renderRuling(ruling), row: { runId: anchor, key } });
    }
  return {
    itemId: found.item.id,
    runs,
    unreadableRuns: unreadable.length,
    openAsks,
    unreadableAsk: readAsks.degraded.length > 0,
    comments,
  };
}

/** The question each run paused at a gate or an attention wait asks. */
function questionComments(runs: readonly WorkflowRun[]): OwedComment[] {
  return runs.flatMap(run => {
    const attention = runAttention(run);
    if (attention?.kind !== 'awaiting_response' && attention?.kind !== 'attention') return [];
    return [
      {
        comment: renderQuestion(run, attention),
        row: { runId: run.id, key: questionKey(attention) },
      },
    ];
  });
}

/** The project's open questions, for the activation baseline. */
async function openQuestionRows(tracked: Tracked): Promise<TrackerRow[]> {
  const candidates = await listTrackerCandidateRuns(tracked.project.project, tracked.destination);
  const rows: TrackerRow[] = [];
  for (const itemKey of new Set(candidates.filter(run => !run.terminal).map(run => run.itemKey))) {
    const found = await getItemRuns(tracked.project.project, itemKey);
    if (found)
      rows.push(...questionComments(splitAttentionRead(found.runs).values).map(q => q.row));
  }
  return rows;
}

/**
 * The run that ended last, when the work on the item is over: every run on it is readable
 * and has ended, no ask is open, and no run's end started a next stage that has no run
 * yet. Runs come in start order, so runs that end in the same second (SQLite's
 * resolution) resolve to the later start.
 */
async function finalResult({
  runs,
  unreadableRuns,
  openAsks,
  unreadableAsk,
}: ItemFacts): Promise<WorkflowRun | undefined> {
  if (unreadableRuns > 0 || unreadableAsk || openAsks.length > 0) return undefined;
  if (runs.some(run => !isTerminalRunStatus(run.status))) return undefined;
  // Any ended run can own the owed stage: with overlapping runs, the one that ended last
  // need not be the one that started last.
  if (await runEndStageOwed(runs.map(run => run.id))) return undefined;
  const ended = (run: WorkflowRun): number => (run.completed_at ?? run.started_at).getTime();
  return runs.reduce<WorkflowRun | undefined>(
    (last, run) => (last && ended(last) > ended(run) ? last : run),
    undefined
  );
}

/**
 * The URL of the newest pull request a run on the item opened through the forge. The
 * events arrive by run in start order, each run's in event order, so the last one wins.
 */
async function proposedChange(runIds: readonly string[]): Promise<string | undefined> {
  const events = await listEventsForRuns(runIds, ['integration_operation']);
  let url: string | undefined;
  for (const row of [...events.values()].flat()) {
    const audit = forgeOperationAuditSchema.safeParse(row.data);
    if (!audit.success || !audit.data.result.ok) continue;
    const { result } = audit.data.result;
    if (result.op === 'pr.create') url = result.value.pr.url;
  }
  return url;
}
