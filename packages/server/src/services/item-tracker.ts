/**
 * The item tracker: one more destination for what the engine records about an item. For
 * each tracked project it keeps one status comment per item on the item's tracker
 * subject, edited in place when a run on the item starts or ends. It reads only engine
 * records and never reads the comment back.
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
import { getItemRuns } from '@archon/core/db/items';
import {
  listTrackerCandidateRuns,
  recordTrackerBaseline,
  type TrackerCandidateRun,
} from '@archon/core/db/item-tracker';
import {
  hasAnyAttentionNotice,
  listAttentionNotices,
  listEventsForRuns,
  persistWorkflowEvent,
} from '@archon/core/db/workflow-events';
import { splitAttentionRead } from '@archon/workflows/schemas/attention-degraded';
import { isTerminalRunStatus } from '@archon/workflows/schemas/run-status';
import type { PushDestinationState } from './attention-router';
import { ITEM_STATUS_MARKER, renderItemStatus, trackerSubject } from './item-tracker-render';

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
type StatusKey = 'started' | 'terminal';

interface Tracked {
  project: TrackedProject;
  destination: string;
  repo?: RepoRef;
  state: TrackerState;
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
      if (!(await hasAnyAttentionNotice(tracked.destination)))
        await getDatabase().withTransaction(query =>
          recordTrackerBaseline(tracked.project.project, tracked.destination, query)
        );
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

  private async scanProject(tracked: Tracked, repo: RepoRef): Promise<void> {
    for (const [itemKey, owed] of await owedRunsByItem(tracked)) {
      const subject = trackerSubject(tracked.project, repo, itemKey);
      if (subject) await this.writeStatus(tracked, itemKey, subject, owed);
      else await this.settleUnmapped(tracked, owed);
    }
  }

  /**
   * An item with no tracker subject gets nothing. Its ended runs are recorded as shown,
   * so the candidate set stays bounded and adding a key rule later cannot post on them.
   */
  private async settleUnmapped(
    tracked: Tracked,
    owed: readonly TrackerCandidateRun[]
  ): Promise<void> {
    for (const run of owed.filter(candidate => candidate.terminal))
      await persistWorkflowEvent({
        workflow_run_id: run.id,
        event_type: 'attention_notice_sent',
        data: { destination: tracked.destination, key: 'terminal', baseline: true },
      });
  }

  private async writeStatus(
    tracked: Tracked,
    itemKey: string,
    subject: ForgeSubjectRef,
    owed: readonly TrackerCandidateRun[]
  ): Promise<void> {
    const write = `${tracked.destination}|${subject.kind}:${String(subject.ref.number)}|${ITEM_STATUS_MARKER}`;
    if (this.refused.has(write)) return;
    const found = await getItemRuns(tracked.project.project, itemKey);
    if (!found) return;
    const { values: runs } = splitAttentionRead(found.runs);
    const runIds = runs.map(run => run.id);
    const response = await this.upsert(tracked, subject, {
      body: renderItemStatus(runs, await proposedChange(runIds), this.config.includeUsage),
    });
    if (!response.ok) {
      this.reportFailure(tracked, found.item.id, write, response);
      return;
    }
    // Record the state each run was shown in; an unreadable run, which the comment
    // cannot show, is recorded in the state the candidate read saw so it is not retried.
    const shown = new Map<string, StatusKey>(
      owed.map(run => [run.id, statusKey(run.terminal)] as const)
    );
    for (const run of runs) shown.set(run.id, statusKey(isTerminalRunStatus(run.status)));
    const latest = latestStatusKeys(
      await listAttentionNotices([...shown.keys()]),
      tracked.destination
    );
    for (const [runId, key] of shown) {
      if (latest.get(runId) === key) continue;
      await persistWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'attention_notice_sent',
        data: { destination: tracked.destination, key },
      });
    }
    this.log.info(
      { destination: tracked.destination, itemId: found.item.id },
      'item_tracker.status_written'
    );
  }

  private async upsert(
    tracked: Tracked,
    subject: ForgeSubjectRef,
    { body }: { body: string }
  ): Promise<ForgeResponse> {
    const operationId = randomUUID();
    try {
      return await this.forge.upsertComment({
        operationId,
        op: UPSERT_OPERATION,
        subject,
        marker: ITEM_STATUS_MARKER,
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

/** The project's runs whose status comment does not show their current state, by item key. */
async function owedRunsByItem(tracked: Tracked): Promise<Map<string, TrackerCandidateRun[]>> {
  const candidates = await listTrackerCandidateRuns(tracked.project.project, tracked.destination);
  const latest = latestStatusKeys(
    await listAttentionNotices(candidates.map(run => run.id)),
    tracked.destination
  );
  const owedByItem = new Map<string, TrackerCandidateRun[]>();
  for (const run of candidates) {
    if (latest.get(run.id) === statusKey(run.terminal)) continue;
    owedByItem.set(run.itemKey, [...(owedByItem.get(run.itemKey) ?? []), run]);
  }
  return owedByItem;
}

function statusKey(terminal: boolean): StatusKey {
  return terminal ? 'terminal' : 'started';
}

/** Each run's latest status row for `destination`; the ledger arrives in event order. */
function latestStatusKeys(
  ledger: Awaited<ReturnType<typeof listAttentionNotices>>,
  destination: string
): Map<string, StatusKey> {
  const latest = new Map<string, StatusKey>();
  for (const { runId, data } of ledger) {
    if (data.destination !== destination) continue;
    if (data.key === 'started' || data.key === 'terminal') latest.set(runId, data.key);
  }
  return latest;
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
