import {
  splitAttentionRead,
  scopeAttentionDegraded,
  type AttentionDegraded,
} from '@archon/workflows/schemas/attention-degraded';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { AttentionWatch } from '@archon/workflows/engine-port';
import { WorkflowEventCursorError, workflowEventCursor } from '@archon/workflows/store';
import { attentionWatchReader, type AttentionWatchLevel } from '@archon/workflows/attention-needs';
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  attentionProjectForCwd,
  projectRefForCodebase,
  attentionQueueSource,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import {
  countAttentionQueue,
  countAttentionWaitStarts,
  type AttentionQueueCounts,
} from '@archon/workflows/attention-counts';
import {
  listAttentionQueue,
  parseAttentionLabelPairs,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueItem,
  type AttentionQueueScope,
  type AttentionQueueSource,
} from '@archon/workflows/attention-queue';
import { MetricsQueryError, resolveMetricsWindow } from '@archon/workflows/metrics';
import { countWorkflowNotices, listWorkflowNotices } from '@archon/workflows/workflow-notice';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import { attentionItemLines, attentionStreamText, noticeText } from './workflow-attention-text';
import {
  getLog,
  inheritedWorkflowCodebase,
  printJsonWriteError,
  resolveRunIdArg,
} from './workflow-shared';

export interface WorkflowAttentionOptions {
  json?: boolean;
  project?: string;
  all?: boolean;
  /** `k=v` filters; every one must match. */
  labels: readonly string[];
  sort?: string;
  countBy?: string;
  /**
   * With `countBy`: count the attention waits opened since this duration ago or ISO time,
   * answered or still open, from events, in place of the items open now.
   */
  since?: string;
  /** Stream every change in scope instead of reading the queue once. */
  watch?: boolean;
  /**
   * With `watch`: write every line of the sync protocol, for a program that keeps an open
   * set. Without it the watch writes only the lines someone has to act on.
   */
  protocol?: boolean;
  /**
   * With `watch`: also write what happened to work that nobody has to act on: a run that
   * completed or resumed, and the notices runs emit. With `since` and no `watch`: list
   * the notices emitted in that window, or count them with `countBy`.
   */
  notices?: boolean;
  /** With `watch` and `protocol`: replay readable feed events strictly after this cursor. */
  after?: string;
}

/**
 * `workflow attention` skips the CLI's project gate, so `cwd` is the raw working
 * directory, not its project root. Resolve its codebase the way the gate does, so a
 * short run id still matches from a project subdirectory.
 */
export async function resolveAttentionRunId(
  host: WorkflowHost,
  runId: string,
  cwd: string
): Promise<string> {
  const { codebase } = await resolveCodebaseForPath(cwd, host.records.codebases);
  return resolveRunIdArg(host, runId, undefined, false, codebase?.id);
}

/** Chat scope takes precedence over the CLI's explicit or working-directory scope. */
export async function attentionScope(
  host: WorkflowHost,
  cwd: string,
  opts: Pick<WorkflowAttentionOptions, 'project' | 'all'>
): Promise<AttentionQueueScope> {
  const inherited = await inheritedWorkflowCodebase(host, opts.all);
  if (inherited) {
    const project = projectRefForCodebase(inherited);
    if (opts.project !== undefined) {
      const requested = await resolveAttentionProject(host.records.codebases, opts.project);
      if (
        requested.codebaseId !== null
          ? requested.codebaseId !== inherited.id
          : requested.key !== project.key
      ) {
        throw new Error('--project cannot override the selected chat project.');
      }
    }
    return { kind: 'project', project };
  }
  if (opts.all) return { kind: 'all' };
  const project =
    opts.project === undefined
      ? await attentionProjectForCwd(host.records.codebases, cwd)
      : await resolveAttentionProject(host.records.codebases, opts.project);
  return { kind: 'project', project };
}

/**
 * `workflow attention --watch`: stream the queue until a signal or a closed stdout. By
 * default it writes only the lines someone has to act on; `--notices` adds what happened
 * to work nobody has to act on; `--protocol` writes every line, for a program that keeps
 * an open set (`attentionWatchReader`). Every JSON line carries its `needs`. Exit 0 on a
 * signal or closed stdout, 1 on other output failures, and 4 on an `error` line: the
 * stream's cursor (from `--after`, or the tail's own position) is not one this install's
 * store can read, so the fix is to rerun without it. Read-only: stopping the stream
 * affects no run.
 */
export async function workflowAttentionWatch(
  host: WorkflowHost,
  cwd: string,
  opts: WorkflowAttentionOptions
): Promise<number> {
  const { labels } = parseAttentionQueueRequest(opts);
  const scope = await attentionScope(host, cwd, opts);
  if (opts.after === '') throw new Error('--after needs a cursor from an earlier line');
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => {
    stop = resolve;
  });
  const level: AttentionWatchLevel = opts.protocol
    ? 'protocol'
    : opts.notices
      ? 'notices'
      : 'quiet';
  const read = attentionWatchReader(level, { resumed: opts.after !== undefined });
  const write = (unclassified: AttentionStreamLine): Promise<void> => {
    const line = read(unclassified);
    // A person starting a watch below the protocol is told it runs, off the stream itself.
    if (!opts.protocol && !opts.json && unclassified.type === 'ready')
      return writeStderr(`${attentionStreamText(unclassified, scope).join('\n')}\n`);
    if (line === undefined) return Promise.resolve();
    if (opts.json) return writeStdout(`${JSON.stringify(line)}\n`);
    if (line.type === 'error')
      return writeStderr(
        'The stream cursor is not one this install can read. Rerun without --after: the stream starts from the open set.\n'
      );
    const text = attentionStreamText(line, scope);
    return text.length === 0 ? Promise.resolve() : writeStdout(`${text.join('\n')}\n`);
  };
  let exitCode = 0;
  const listener = async (line: AttentionStreamLine): Promise<void> => {
    if (line.type === 'error') {
      exitCode = 4;
      stop();
    }
    try {
      await write(line);
    } catch (error) {
      stop();
      if (error instanceof Error && 'code' in error && error.code === 'EPIPE') {
        getLog().debug({ err: error }, 'cli.workflow_attention_watch_stdout_closed');
        return;
      }
      exitCode = 1;
      getLog().error({ err: error as Error }, 'cli.workflow_attention_watch_write_failed');
      throw error;
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    let watch: AttentionWatch;
    try {
      watch = await host.engine.watchAttention(listener, {
        scope,
        labels,
        ...(opts.after === undefined ? {} : { after: workflowEventCursor(opts.after) }),
      });
    } catch (error) {
      if (!(error instanceof WorkflowEventCursorError)) throw error;
      await listener({ type: 'error', error: 'cursor_invalid' });
      return exitCode;
    }
    await stopped;
    await watch.close();
    return exitCode;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/**
 * The attention queue as typed JSON for answerers outside Archon: the items in scope,
 * how many fall under each project or label value, or the one item a run stands for.
 * Read-only; answering goes through `answer`, `approve`, `reject` or `respond`.
 */
export async function workflowAttentionCommand(
  host: WorkflowHost,
  cwd: string,
  runId: string | undefined,
  opts: WorkflowAttentionOptions
): Promise<number> {
  try {
    rejectConflictingAttentionOptions(runId, opts);
    if (opts.watch) return await workflowAttentionWatch(host, cwd, opts);
    const source = attentionQueueSource(host.deps.store, host.records.isolation);
    if (runId !== undefined) return await attentionRunCommand(host, cwd, source, runId, opts.json);

    const { labels, order, countBy } = parseAttentionQueueRequest(opts);
    const scope = await attentionScope(host, cwd, opts);
    if (opts.notices && opts.since !== undefined)
      return await noticesCommand(host, scope, labels, countBy, opts.since, opts.json);
    if (opts.since !== undefined && countBy !== undefined) {
      const { since } = resolveMetricsWindow({ since: opts.since });
      return await renderAttentionCounts(
        await countAttentionWaitStarts(
          { store: host.deps.store },
          { scope, labels, countBy, since }
        ),
        scope,
        opts.json,
        [],
        'No attention waits opened in that window.'
      );
    }
    const { values: items, degraded } = splitAttentionRead(await listAttentionQueue(source));
    const reports = scopeAttentionDegraded(degraded, scope).degraded ?? [];
    if (countBy !== undefined)
      return await renderAttentionCounts(
        countAttentionQueue(items, { scope, labels, countBy }),
        scope,
        opts.json,
        reports
      );
    return await renderAttentionItems(
      selectAttentionQueue(items, { scope, labels, order }),
      scope,
      opts.json,
      reports
    );
  } catch (error) {
    return attentionCommandFailure(error, runId, opts.json);
  }
}

/** A flag that only shapes another flag's mode is refused without it. */
function rejectFlagsWithoutTheirMode(opts: WorkflowAttentionOptions): void {
  const needs = (flag: string, mode: string): never => {
    throw new Error(`workflow attention ${flag} needs ${mode}`);
  };
  if (opts.protocol && !opts.watch) needs('--protocol', '--watch');
  if (opts.notices && !opts.watch && opts.since === undefined)
    needs('--notices', '--watch, or --since to list the notices of a window');
  if (opts.notices && opts.protocol)
    throw new Error('workflow attention --watch takes --notices or --protocol, not both');
  if (opts.after !== undefined && !opts.protocol) needs('--after', '--watch --protocol');
  if (opts.since !== undefined && opts.countBy === undefined && !opts.notices)
    needs('--since', '--count-by or --notices');
  if (opts.since !== undefined && opts.watch)
    throw new Error('workflow attention --watch takes no --since; the stream starts now');
}

/**
 * `workflow attention --notices --since <window>`: the notices runs emitted in the window,
 * oldest first, or how many fall under each project or label value.
 */
async function noticesCommand(
  host: WorkflowHost,
  scope: AttentionQueueScope,
  labels: AttentionQueueItem['labels'],
  countBy: ReturnType<typeof parseAttentionQueueRequest>['countBy'],
  sinceText: string,
  json: boolean | undefined
): Promise<number> {
  const { since } = resolveMetricsWindow({ since: sinceText });
  const source = { store: host.deps.store };
  if (countBy !== undefined) {
    if (countBy.by === 'answerer') throw new Error('A notice has no answerer to count by');
    return await renderAttentionCounts(
      await countWorkflowNotices(source, { scope, labels, since, countBy }),
      scope,
      json,
      [],
      'No notices in that window.'
    );
  }
  const notices = await listWorkflowNotices(source, { scope, labels, since });
  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'attention',
      scope,
      since: since.toISOString(),
      notices,
    });
    return 0;
  }
  for (const notice of notices) console.log(noticeText(notice));
  if (notices.length === 0) console.log('No notices in that window.');
  return 0;
}

function rejectConflictingAttentionOptions(
  runId: string | undefined,
  opts: WorkflowAttentionOptions
): void {
  rejectFlagsWithoutTheirMode(opts);
  const shaped = opts.sort !== undefined || opts.countBy !== undefined;
  if (opts.notices && !opts.watch && (runId !== undefined || opts.sort !== undefined))
    throw new Error('workflow attention --notices --since takes no run id or --sort');
  if (opts.watch && (runId !== undefined || shaped))
    throw new Error('workflow attention --watch takes no run id, --sort or --count-by');
  const scoped = opts.project !== undefined || opts.all || opts.labels.length > 0;
  if (runId !== undefined && (scoped || shaped))
    throw new Error(
      'workflow attention <run-id> takes no --project, --all, --label, --sort or --count-by'
    );
}

/** `workflow attention <run-id>`: the one item the run stands for, null when it needs none. */
async function attentionRunCommand(
  host: WorkflowHost,
  cwd: string,
  source: AttentionQueueSource,
  runId: string,
  json: boolean | undefined
): Promise<number> {
  const resolvedId = await resolveAttentionRunId(host, runId, cwd);
  const item = await readAttentionQueueItem(source, resolvedId);
  if (item === undefined) {
    if (json) await writeJsonLine({ ok: false, runId, action: 'attention', error: 'not_found' });
    else console.log(`Workflow run not found: ${runId}`);
    return 1;
  }
  if (json) await writeJsonLine({ ok: true, action: 'attention', runId: resolvedId, item });
  else if (item === null) console.log(`Run ${resolvedId} needs no attention now.`);
  else for (const line of attentionItemLines(item, 'full')) console.log(line);
  return 0;
}

function printAttentionDegraded(reports: readonly AttentionDegraded[]): void {
  for (const report of reports) {
    console.log(
      `Attention coverage incomplete: ${report.runId === undefined ? 'a paused run' : `run ${report.runId}`} could not be read. Check operator logs, repair the stored run, then read again.`
    );
  }
}

async function renderAttentionCounts(
  counts: AttentionQueueCounts,
  scope: AttentionQueueScope,
  json: boolean | undefined,
  degraded: AttentionDegraded[],
  none = 'No runs need attention.'
): Promise<number> {
  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'attention',
      scope,
      counts,
      ...(degraded.length === 0 ? {} : { degraded }),
    });
    return 0;
  }
  printAttentionDegraded(degraded);
  const rows = attentionCountRows(counts);
  for (const [entry, name] of rows)
    console.log(
      `  ${String(entry.count).padStart(4)}  ${name}${recommendationText(entry.recommendations)}`
    );
  if (rows.length === 0)
    console.log(
      degraded.length === 0
        ? none
        : 'No readable matching runs need attention; counts are incomplete.'
    );
  return 0;
}

type AttentionCountEntry = AttentionQueueCounts['counts'][number];

/** Each group of a count with the name it prints under. */
function attentionCountRows(counts: AttentionQueueCounts): [AttentionCountEntry, string][] {
  switch (counts.by) {
    case 'project':
      return counts.counts.map(entry => [entry, entry.project?.name ?? '(no project)']);
    case 'label':
      return counts.counts.map(entry => [entry, entry.value ?? `(no '${counts.key}' label)`]);
    case 'answerer':
      return counts.counts.map(entry => [
        entry,
        entry.answeredBy === null
          ? '(open, or answerer not recorded)'
          : 'declared' in entry.answeredBy
            ? `${entry.answeredBy.declared} (self-declared)`
            : `user ${entry.answeredBy.userId}`,
      ]);
  }
}

/** How a group's recommendations fared; empty when the count is of open items or none carried one. */
function recommendationText(totals: AttentionCountEntry['recommendations']): string {
  if (totals === undefined || totals.asked === 0) return '';
  return `  (${String(totals.asked)} with a recommendation: ${String(totals.answered)} answered, ${String(totals.followed)} as recommended)`;
}

async function renderAttentionItems(
  selected: AttentionQueueItem[],
  scope: AttentionQueueScope,
  json: boolean | undefined,
  degraded: AttentionDegraded[]
): Promise<number> {
  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'attention',
      scope,
      items: selected,
      ...(degraded.length === 0 ? {} : { degraded }),
    });
    return 0;
  }
  printAttentionDegraded(degraded);
  const where = scope.kind === 'all' ? 'this install' : `project ${scope.project.name}`;
  if (selected.length === 0) {
    console.log(
      degraded.length === 0
        ? `No runs need attention in ${where}.`
        : `No readable matching runs need attention in ${where}; coverage is incomplete.`
    );
    return 0;
  }
  console.log(`\n${String(selected.length)} run(s) need attention in ${where}:\n`);
  for (const item of selected) {
    for (const line of attentionItemLines(item, 'brief')) console.log(line);
    console.log('');
  }
  return 0;
}

async function attentionCommandFailure(
  error: unknown,
  runId: string | undefined,
  json: boolean | undefined
): Promise<number> {
  const err = error as Error;
  if (!(error instanceof MetricsQueryError))
    getLog().error({ err, runId }, 'cli.workflow_attention_failed');
  if (!json) throw new Error(`Failed to read the attention queue: ${err.message}`, { cause: err });
  await writeJsonLine({
    ok: false,
    ...(runId ? { runId } : {}),
    action: 'attention',
    error: err.message,
  });
  return 1;
}

/**
 * Merge a label write into the attention wait a run is paused at: `set` pairs replace
 * the same keys, `unset` keys are removed, nothing else changes. Refused when the run is
 * no longer at `occurrence`.
 */
export async function workflowAttentionLabelCommand(
  host: WorkflowHost,
  runId: string,
  occurrence: string,
  set: readonly string[],
  unset: readonly string[],
  json: boolean | undefined,
  cwd: string
): Promise<number> {
  try {
    const resolvedId = await resolveAttentionRunId(host, runId, cwd);
    const result = await host.operations.labelAttentionWait(
      resolvedId,
      { occurrence, set: parseAttentionLabelPairs(set), unset },
      { kind: 'operator' },
      'cli'
    );
    if (json) {
      await writeJsonLine({ ok: true, action: 'attention_label', ...result });
    } else {
      const labels = Object.entries(result.labels).map(([key, value]) => `${key}=${value}`);
      console.log(
        `Labeled run ${result.runId} at revision ${String(result.revision)}: ${
          labels.length > 0 ? labels.join(', ') : 'no labels'
        }`
      );
    }
    return 0;
  } catch (error) {
    if (!json) throw error;
    await printJsonWriteError(runId, 'attention_label', error);
    return 1;
  }
}
