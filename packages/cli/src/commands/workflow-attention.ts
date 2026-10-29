import {
  splitAttentionRead,
  scopeAttentionDegraded,
  type AttentionDegraded,
} from '@archon/workflows/schemas/attention-degraded';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { AttentionWatch } from '@archon/workflows/engine-port';
import { WorkflowEventCursorError, workflowEventCursor } from '@archon/workflows/store';
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
  listAttentionQueue,
  parseAttentionLabelPairs,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueCounts,
  type AttentionQueueItem,
  type AttentionQueueScope,
  type AttentionQueueSource,
} from '@archon/workflows/attention-queue';
import { attentionAnswerLines, spellWorkflowCommand } from '@archon/workflows/deps';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import {
  formatAge,
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
  /** Stream every change in scope instead of reading the queue once. */
  watch?: boolean;
  /** With `watch`: replay readable feed events strictly after this cursor. */
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

function attentionItemLines(item: AttentionQueueItem): string[] {
  const paused =
    item.pausedAt === null ? 'pause time not recorded' : `paused ${formatAge(item.pausedAt)} ago`;
  const lines = [
    `  ${item.runId}  ${item.workflow}  ${item.project?.name ?? '(no project)'}  ${paused}`,
  ];
  if (item.fanOut !== null)
    lines.push(`    fan-out item ${String(item.fanOut.index)} of run ${item.fanOut.parentRunId}`);
  else if (item.parentRunId !== null) lines.push(`    child of run ${item.parentRunId}`);
  const labels = Object.entries(item.labels);
  if (labels.length > 0)
    lines.push(`    labels: ${labels.map(([key, value]) => `${key}=${value}`).join(', ')}`);
  switch (item.kind) {
    case 'attention':
      lines.push(`    ${item.node}: ${item.message}`);
      for (const line of attentionAnswerLines(CLI_WORKFLOW_SURFACE, item))
        lines.push(`    ${line}`);
      break;
    case 'awaiting_response':
      lines.push(
        `    gate '${item.node}': ${item.message}`,
        `    Answer with ${spellWorkflowCommand(CLI_WORKFLOW_SURFACE, `approve ${item.runId}`)}, reject or respond.`
      );
      break;
    case 'usage_limit':
      lines.push(
        `    ${item.node}: provider usage or rate limit reached; tries again by itself at ${item.resetAt}`,
        `    Retry sooner with ${spellWorkflowCommand(CLI_WORKFLOW_SURFACE, `resume ${item.runId}`)}, or stop it with ${spellWorkflowCommand(CLI_WORKFLOW_SURFACE, `abandon ${item.runId}`)}.`
      );
      break;
    case 'unreadable':
      lines.push(`    needs a look: ${item.detail}`);
      break;
  }
  return lines;
}

export function printAttentionItem(item: AttentionQueueItem): void {
  for (const line of attentionItemLines(item)) console.log(line);
}

type RunLine = Extract<AttentionStreamLine, { runId: string }>;

/** What the run is part of, as a trailing sentence; empty when the stream could not read it. */
function runContextText(line: RunLine): string {
  if (line.workflow === null) return '';
  return line.parentRunId === null
    ? ` Workflow ${line.workflow}.`
    : ` Workflow ${line.workflow}, child of run ${line.parentRunId}.`;
}

function terminalText(line: Extract<AttentionStreamLine, { type: 'terminal' }>): string {
  const outcome = line.outcome === null ? '' : ` (${line.outcome})`;
  const cause =
    line.cause === null
      ? ''
      : `: node ${line.cause.node} (${line.cause.errorClass ?? 'error class not recorded'})`;
  return `Run ${line.runId} ${line.status}${outcome}${cause}.`;
}

/** The text for one stream line; none for a bookmark. */
function attentionStreamText(
  line: Exclude<AttentionStreamLine, { type: 'error' }>,
  scope: AttentionQueueScope
): string[] {
  switch (line.type) {
    case 'attention':
      return [
        line.snapshot ? 'Needs attention:' : 'Needs attention now:',
        ...attentionItemLines(line.item),
      ];
    case 'resolved':
      return [
        (line.reason === 'answered'
          ? `Run ${line.runId} was answered${line.answeredVia === null ? '' : ` via ${line.answeredVia}`}.`
          : `Run ${line.runId} no longer needs attention.`) + runContextText(line),
      ];
    case 'unmatched':
      return [`Run ${line.runId} no longer matches the label filter.${runContextText(line)}`];
    case 'terminal':
      return [terminalText(line) + runContextText(line)];
    case 'resumed':
      return [`Run ${line.runId} resumed (${line.status}).${runContextText(line)}`];
    case 'owner_lost':
      return [
        `Run ${line.runId} is ${line.observedStatus} but its owner is gone. ` +
          `Abandon it with ${spellWorkflowCommand(CLI_WORKFLOW_SURFACE, `abandon ${line.runId}`)}.` +
          runContextText(line),
      ];
    case 'ready':
      return [
        `Watching ${scope.kind === 'all' ? 'this install' : `project ${scope.project.name}`} for attention. Ctrl-C stops.`,
      ];
    case 'degraded':
      return [
        'Attention stream coverage may be incomplete because a run could not be read. Check the operator log; reconnect after repairing the read failure.',
      ];
    case 'bookmark':
      return [];
  }
}

/**
 * `workflow attention --watch`: stream the queue until a signal or a closed stdout. Exit
 * 0 then, 1 on other output failures, and 4 on an `error` line: the stream's cursor
 * (from `--after`, or the tail's own position) is not one this install's store can read,
 * so the fix is to rerun without it. Read-only: stopping the stream affects no run.
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
  const write = (line: AttentionStreamLine): Promise<void> => {
    if (opts.json) return writeStdout(`${JSON.stringify(line)}\n`);
    if (line.type === 'error')
      return writeStderr(
        'The stream cursor is not one this install can read. Rerun without --after: the lines before "ready" are the open set.\n'
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

function rejectConflictingAttentionOptions(
  runId: string | undefined,
  opts: WorkflowAttentionOptions
): void {
  if (opts.after !== undefined && !opts.watch)
    throw new Error('workflow attention --after needs --watch');
  const shaped = opts.sort !== undefined || opts.countBy !== undefined;
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
  else printAttentionItem(item);
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
  degraded: AttentionDegraded[]
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
  const rows =
    counts.by === 'project'
      ? counts.counts.map(entry => [entry.count, entry.project?.name ?? '(no project)'] as const)
      : counts.counts.map(
          entry => [entry.count, entry.value ?? `(no '${counts.key}' label)`] as const
        );
  for (const [count, name] of rows) console.log(`  ${String(count).padStart(4)}  ${name}`);
  if (rows.length === 0)
    console.log(
      degraded.length === 0
        ? 'No runs need attention.'
        : 'No readable matching runs need attention; counts are incomplete.'
    );
  return 0;
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
    printAttentionItem(item);
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
