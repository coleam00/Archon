/**
 * The item tracker: one more destination for what the engine records about an item. For
 * each tracked project it keeps one status comment per item on the item's tracker
 * subject, edited in place when a run on the item starts or ends, and posts a new comment
 * once for each question, ask and ruling, and for the final result. It reads only engine
 * records and never reads a comment back.
 *
 * It polls durable facts with a ledger instead of subscribing to the in-process emitter,
 * so a pass can run in any process: the server runs one on its timer, a CLI process that
 * started, paused or ended a run runs one before it exits, and `archon tracker sync` runs
 * one on demand. One pass per destination runs at a time across processes
 * (`claimTrackerPass`); a pass that finds the destination held can ask the holder for one
 * more instead.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, getPluginsPath } from '@archon/paths';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import { currentProcessOwner, type ProcessOwner } from '@archon/paths/process-owner';
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
import { listItemAsks } from '@archon/core/db/item-asks';
import { listItemRulings } from '@archon/core/db/item-rulings';
import { getItemRuns } from '@archon/core/db/items';
import {
  abandonTrackerPass,
  activateTrackerDestination,
  claimTrackerPass,
  finishTrackerPass,
  listTrackerCandidateRuns,
  listTrackerItemsOwingComments,
  listTrackerLedger,
  listTrackerResultsOwed,
  runEndStageOwed,
  TRACKER_RESULT_KEY,
  trackerAskKey,
  trackerRulingKey,
  trackerStatusKey,
  type TrackerCandidateRun,
  type TrackerRow,
} from '@archon/core/db/item-tracker';
import { listEventsForRuns, persistWorkflowEvent } from '@archon/core/db/workflow-events';
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import { isTerminalRunStatus } from '@archon/workflows/schemas/run-status';
import { runAttention, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
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

/** The states a tracker destination reports in `/api/health`. */
export type TrackerState = 'active' | 'misconfigured';

/** Why a project's tracker writes nothing: its repo or its forge plugin. */
export interface TrackerProblem {
  errorKind: string;
  unsupported?: string[];
}

/** One comment a pass wrote, by the item's key and the comment's marker. */
export interface TrackerWrite {
  item: string;
  marker: string;
}

/** A comment a pass owed and did not write; `retried` when a later pass tries it again. */
export interface TrackerMissedWrite extends TrackerWrite {
  errorKind: string;
  retried: boolean;
}

/** What one pass did for one tracked project. */
export type TrackerPassReport = { project: string } & (
  | { outcome: 'scanned'; posted: TrackerWrite[]; notPosted: TrackerMissedWrite[] }
  /** Another process runs the project's pass; it was asked for one more when requested. */
  | { outcome: 'held'; heldBy: ProcessOwner; since: string }
  | ({ outcome: 'misconfigured' } & TrackerProblem)
  /** The pass threw; what it owed stays owed. */
  | { outcome: 'failed'; error: string }
);

type Tracked = {
  project: TrackedProject;
  destination: string;
} & ({ state: 'active'; repo: RepoRef } | { state: 'misconfigured'; problem: TrackerProblem });

/** The writes of one pass over one project. */
interface PassWrites {
  posted: TrackerWrite[];
  notPosted: TrackerMissedWrite[];
}

/** The ledger's destination id for a tracked project. */
export function itemTrackerDestinationId(projectKey: string): string {
  return `tracker:${projectKey}`;
}

export class ItemTracker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<TrackerPassReport[]> | undefined;
  private stopped = true;
  private readonly log = createLogger('item-tracker');
  private tracked: Tracked[];
  /**
   * Writes the forge refused for good, with the error kind it gave; not retried by this
   * instance, so a bad key costs one call per process.
   */
  private readonly refused = new Map<string, string>();

  constructor(
    private readonly config: ItemTrackerConfig,
    private readonly forge: ItemTrackerForge,
    /** The process this tracker's passes run as; a test simulates a second process. */
    private readonly owner: ProcessOwner = currentProcessOwner
  ) {
    // A project is misconfigured until `activate` has checked its plugin and committed
    // its baseline.
    this.tracked = config.projects.map(project => ({
      project,
      destination: itemTrackerDestinationId(project.project),
      state: 'misconfigured',
      problem: { errorKind: 'not_activated' },
    }));
  }

  /** Check each project's forge plugin once, and baseline a project's first activation. */
  async activate(): Promise<void> {
    const activated: Tracked[] = [];
    for (const tracked of this.tracked) {
      const { project, destination } = tracked;
      const checked = await this.checkProject(project);
      if ('problem' in checked) {
        this.log.error(
          { project: project.project, ...checked.problem },
          'item_tracker.misconfigured'
        );
        activated.push({ project, destination, state: 'misconfigured', problem: checked.problem });
        continue;
      }
      const active: Tracked = { project, destination, state: 'active', repo: checked.repo };
      await activateTrackerDestination(project.project, destination, () =>
        openQuestionRows(active)
      );
      activated.push(active);
    }
    this.tracked = activated;
  }

  private async checkProject(
    project: TrackedProject
  ): Promise<{ repo: RepoRef } | { problem: TrackerProblem }> {
    const repo = repoRefSchema.safeParse(project.repo);
    if (!repo.success) return { problem: { errorKind: 'invalid_repo' } };
    let check: ForgeAccessCheck;
    try {
      check = await this.forge.check({ host: repo.data.host, operations: [UPSERT_OPERATION] });
    } catch (err) {
      this.log.error({ err, project: project.project }, 'item_tracker.check_failed');
      return { problem: { errorKind: 'check_failed' } };
    }
    if (check.ok) return { repo: repo.data };
    return {
      problem: {
        errorKind: check.error.kind,
        ...(check.unsupported ? { unsupported: check.unsupported } : {}),
      },
    };
  }

  health(): { id: string; state: TrackerState }[] {
    return this.tracked.map(tracked => ({ id: tracked.destination, state: tracked.state }));
  }

  /**
   * One pass over every tracked project. With `request`, a project whose pass another
   * process holds asks that holder for one more pass, for a caller that will not come back
   * (a CLI process about to exit). The server's timer returns anyway, so it does not ask.
   */
  scan(options: { request: boolean } = { request: false }): Promise<TrackerPassReport[]> {
    this.scanning ??= this.scanOnce(options.request).finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scanOnce(request: boolean): Promise<TrackerPassReport[]> {
    const reports: TrackerPassReport[] = [];
    for (const tracked of this.tracked) reports.push(await this.passProject(tracked, request));
    return reports;
  }

  /**
   * Hold the project's pass and scan until no other process has asked for one more. A pass
   * that throws lets go of the pass; what it did not write stays owed.
   */
  private async passProject(tracked: Tracked, request: boolean): Promise<TrackerPassReport> {
    const project = tracked.project.project;
    if (tracked.state === 'misconfigured')
      return { project, outcome: 'misconfigured', ...tracked.problem };
    const { destination } = tracked;
    let claimed = false;
    try {
      const claim = await claimTrackerPass(destination, this.owner, request);
      if (!claim.claimed) {
        this.log.info(
          { destination, heldBy: claim.heldBy, since: claim.since },
          'item_tracker.pass_held'
        );
        return { project, outcome: 'held', heldBy: claim.heldBy, since: claim.since };
      }
      claimed = true;
      const writes: PassWrites = { posted: [], notPosted: [] };
      do await this.scanProject(tracked, tracked.repo, writes);
      while ((await finishTrackerPass(destination, this.owner)) === 'again');
      return { project, outcome: 'scanned', ...writes };
    } catch (err) {
      this.log.error({ err, destination }, 'item_tracker.pass_failed');
      if (claimed)
        await abandonTrackerPass(destination, this.owner).catch((abandonErr: unknown) => {
          this.log.error({ err: abandonErr, destination }, 'item_tracker.pass_release_failed');
        });
      return {
        project,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Each item that may owe a write: one with a live run (it may have paused), a run whose
   * status comment does not show its current state, an ask or ruling not yet posted, or
   * a final result not yet posted.
   */
  private async scanProject(tracked: Tracked, repo: RepoRef, writes: PassWrites): Promise<void> {
    const projectKey = tracked.project.project;
    const candidates = await listTrackerCandidateRuns(projectKey, tracked.destination);
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
      if (subject) await this.writeItem(tracked, itemKey, subject, owedRuns, writes);
      else if (
        owedRuns.length > 0 ||
        owingComments.includes(itemKey) ||
        owingResults.includes(itemKey)
      )
        await this.settleUnmapped(tracked, itemKey, owedRuns);
    }
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
    owedRuns: readonly TrackerCandidateRun[],
    writes: PassWrites
  ): Promise<void> {
    const facts = await itemFacts(tracked, itemKey);
    if (!facts) return;
    const { itemId, runs, comments } = facts;
    const write = (comment: TrackerComment): Promise<boolean> =>
      this.writeComment(tracked, { itemId, itemKey }, subject, comment, writes);
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
    item: { itemId: string; itemKey: string },
    subject: ForgeSubjectRef,
    comment: TrackerComment,
    writes: PassWrites
  ): Promise<boolean> {
    const written = { item: item.itemKey, marker: comment.marker };
    const write = `${tracked.destination}|${subject.kind}:${String(subject.ref.number)}|${comment.marker}`;
    const refusedKind = this.refused.get(write);
    if (refusedKind !== undefined) {
      writes.notPosted.push({ ...written, errorKind: refusedKind, retried: false });
      return false;
    }
    const response = await this.upsert(tracked, subject, comment);
    if (!response.ok) {
      const retried = this.reportFailure(tracked, item.itemId, write, response);
      writes.notPosted.push({ ...written, errorKind: response.error.kind, retried });
      return false;
    }
    this.log.info(
      { destination: tracked.destination, itemId: item.itemId },
      'item_tracker.comment_written'
    );
    writes.posted.push(written);
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
   * as a key naming an issue that does not exist, is not retried by this instance, so a
   * running server tries it again only after a restart. The upsert's marker makes a retry
   * after an unknown outcome safe: it edits, never posts twice. Returns whether a later
   * scan retries the write.
   */
  private reportFailure(
    tracked: Tracked,
    itemId: string,
    write: string,
    response: Extract<ForgeResponse, { ok: false }>
  ): boolean {
    const outcome = response.mutation?.outcome ?? 'refused';
    const temporary = (temporaryErrorKinds as readonly string[]).includes(response.error.kind);
    const settled = outcome === 'refused' && !temporary && response.error.kind !== 'process_failed';
    if (settled) this.refused.set(write, response.error.kind);
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
    return !settled;
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
