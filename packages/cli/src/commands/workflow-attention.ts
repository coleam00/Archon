import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { AttentionWatch } from '@archon/workflows/engine-port';
import { WorkflowEventCursorError, workflowEventCursor } from '@archon/workflows/store';
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import {
  attentionProjectForCwd,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import {
  parseAttentionQueueRequest,
  type AttentionQueueItem,
  type AttentionQueueScope,
} from '@archon/workflows/attention-queue';
import { attentionAnswerLines, spellWorkflowCommand } from '@archon/workflows/deps';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { writeStderr, writeStdout } from '../utils/stdout';
import { formatAge, getLog, resolveRunIdArg } from './workflow-shared';

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

/** The scope a list or count covers: `--all`, `--project`, or the working directory's project. */
export async function attentionScope(
  host: WorkflowHost,
  cwd: string,
  opts: Pick<WorkflowAttentionOptions, 'project' | 'all'>
): Promise<AttentionQueueScope> {
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
