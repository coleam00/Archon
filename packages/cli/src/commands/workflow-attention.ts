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
  type AttentionQueueItem,
  type AttentionQueueScope,
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
    if (opts.project !== undefined) {
      const requested = await resolveAttentionProject(host.records.codebases, opts.project);
      if (requested.codebaseId !== inherited.id) {
        throw new Error('--project cannot override the selected chat project.');
      }
    }
    return { kind: 'project', project: projectRefForCodebase(inherited) };
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
        line.reason === 'answered'
          ? `Run ${line.runId} was answered${line.answeredVia === null ? '' : ` via ${line.answeredVia}`}.`
          : `Run ${line.runId} no longer needs attention.`,
      ];
    case 'unmatched':
      return [`Run ${line.runId} no longer matches the label filter.`];
    case 'terminal':
      return [
        `Run ${line.runId} ${line.status}${line.outcome === null ? '' : ` (${line.outcome})`}.`,
      ];
    case 'resumed':
      return [`Run ${line.runId} resumed (${line.status}).`];
    case 'owner_lost':
      return [
        `Run ${line.runId} is ${line.observedStatus} but its owner is gone. ` +
          `Abandon it with ${spellWorkflowCommand(CLI_WORKFLOW_SURFACE, `abandon ${line.runId}`)}.`,
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
    if (opts.after !== undefined && !opts.watch)
      throw new Error('workflow attention --after needs --watch');
    if (opts.watch) {
      if (runId !== undefined || opts.sort !== undefined || opts.countBy !== undefined)
        throw new Error('workflow attention --watch takes no run id, --sort or --count-by');
      return await workflowAttentionWatch(host, cwd, opts);
    }
    const source = attentionQueueSource(host.deps.store, host.records.isolation);
    if (runId !== undefined) {
      if (
        opts.project !== undefined ||
        opts.all ||
        opts.labels.length > 0 ||
        opts.sort !== undefined ||
        opts.countBy !== undefined
      )
        throw new Error(
          'workflow attention <run-id> takes no --project, --all, --label, --sort or --count-by'
        );
      const resolvedId = await resolveAttentionRunId(host, runId, cwd);
      const item = await readAttentionQueueItem(source, resolvedId);
      if (item === undefined) {
        if (opts.json)
          await writeJsonLine({ ok: false, runId, action: 'attention', error: 'not_found' });
        else console.log(`Workflow run not found: ${runId}`);
        return 1;
      }
      if (opts.json) {
        await writeJsonLine({ ok: true, action: 'attention', runId: resolvedId, item });
      } else if (item === null) {
        console.log(`Run ${resolvedId} needs no attention now.`);
      } else {
        printAttentionItem(item);
      }
      return 0;
    }

    const { labels, order, countBy } = parseAttentionQueueRequest(opts);
    const scope = await attentionScope(host, cwd, opts);
    const items = await listAttentionQueue(source);

    if (countBy !== undefined) {
      const counts = countAttentionQueue(items, { scope, labels, countBy });
      if (opts.json) {
        await writeJsonLine({ ok: true, action: 'attention', scope, counts });
        return 0;
      }
      const rows =
        counts.by === 'project'
          ? counts.counts.map(
              entry => [entry.count, entry.project?.name ?? '(no project)'] as const
            )
          : counts.counts.map(
              entry => [entry.count, entry.value ?? `(no '${counts.key}' label)`] as const
            );
      for (const [count, name] of rows) console.log(`  ${String(count).padStart(4)}  ${name}`);
      if (rows.length === 0) console.log('No runs need attention.');
      return 0;
    }

    const selected = selectAttentionQueue(items, { scope, labels, order });
    if (opts.json) {
      await writeJsonLine({ ok: true, action: 'attention', scope, items: selected });
      return 0;
    }
    const where = scope.kind === 'all' ? 'this install' : `project ${scope.project.name}`;
    if (selected.length === 0) {
      console.log(`No runs need attention in ${where}.`);
      return 0;
    }
    console.log(`\n${String(selected.length)} run(s) need attention in ${where}:\n`);
    for (const item of selected) {
      printAttentionItem(item);
      console.log('');
    }
    return 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_attention_failed');
    if (opts.json) {
      await writeJsonLine({
        ok: false,
        ...(runId ? { runId } : {}),
        action: 'attention',
        error: err.message,
      });
      return 1;
    }
    throw new Error(`Failed to read the attention queue: ${err.message}`, { cause: err });
  }
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
