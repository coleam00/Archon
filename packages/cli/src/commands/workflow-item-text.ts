/**
 * The text of an item read (`workflow runs --item`): its runs, its starts with no run,
 * open questions, and answers with rulings, each oldest first. Built from the same
 * `ItemRead` that `--json` prints.
 */
import type {
  ItemAnswer,
  ItemHeldBehind,
  ItemRead,
  ItemRun,
  ItemStart,
} from '@archon/workflows/item-read';
import { answererText, attentionItemLines } from './workflow-attention-text';

/** A recorded time to the minute, or the stored text when it does not parse. */
function minute(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : `${time.toISOString().slice(0, 16)}Z`;
}

function answerText(answer: Exclude<ItemAnswer, { kind: 'ruling' }>): string {
  if (answer.kind === 'gate') {
    const text = answer.text === null || answer.text === '' ? '' : `: ${answer.text}`;
    return `gate ${answer.decision ?? '(decision not recorded)'}${text}`;
  }
  if (answer.answer === null) return 'answered (answer not recorded)';
  const chosen =
    'decisions' in answer.answer
      ? answer.answer.decisions.join(', ')
      : 'decision' in answer.answer
        ? answer.answer.decision
        : undefined;
  const parts = [chosen, answer.answer.text === '' ? undefined : answer.answer.text];
  return `answered ${parts.filter(part => part !== undefined).join(': ')}${answererText(answer.by)}`;
}

function causeText(cause: ItemRun['cause']): string {
  if (cause === null) return '';
  if (cause.kind === 'run_ended') return ` · after run ${cause.runId.slice(0, 8)} ended`;
  if (cause.kind === 'run_fired')
    return ` · fired by run ${cause.runId.slice(0, 8)}${cause.node === null ? '' : ` (${cause.node})`}`;
  return ` · trigger ${cause.sourceInstanceId}`;
}

/**
 * The run a start is held behind. When that run's owner is gone, only an operator moves
 * it, so both actions are printed; the engine never ends it.
 */
function heldBehindLines(verb: string, held: ItemHeldBehind): string[] {
  const lines = [
    `            ${verb} run ${held.runId.slice(0, 8)} (${held.workflow}, ${held.status}): one run of a workflow works an item at a time.`,
  ];
  if (held.owner === 'unreachable')
    lines.push(
      `            Run ${held.runId.slice(0, 8)} has lost its owner. Continue it with archon workflow resume ${held.runId}, or end it with archon workflow abandon ${held.runId}.`
    );
  return lines;
}

function startLines(start: ItemStart): string[] {
  const lines = [
    `  ${start.requestId.slice(0, 8)}  ${start.status.padEnd(9)}  ${start.workflow} · resource ${start.resource}`,
  ];
  if (start.heldBehind)
    lines.push(
      ...heldBehindLines(
        start.status === 'queued' ? 'waits behind' : 'refused, held by',
        start.heldBehind
      )
    );
  return lines;
}

/** One run, and how to start it when it was admitted but no process is running it. */
function runLines(run: ItemRun): string[] {
  const outcome = run.outcome === null ? '' : ` · authored outcome: ${run.outcome}`;
  const ended = run.completedAt === null ? '' : ` → ${minute(run.completedAt)}`;
  const lines = [
    `  ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  ${run.workflow}${outcome}  ${minute(run.startedAt)}${ended}${causeText(run.cause)}`,
  ];
  const waiting = run.awaitingExecution;
  if (waiting)
    lines.push(
      `            admitted, not started. If no process is running it: archon trigger execute ${waiting.requestId} --host ${waiting.hostId}`
    );
  if (run.heldBehind) lines.push(...heldBehindLines('waits behind', run.heldBehind));
  return lines;
}

/** One answer or ruling; a ruling is held by no run, so it names its id instead. */
function answerLine(answer: ItemAnswer): string {
  const via = answer.via === null ? '' : ` (via ${answer.via})`;
  if (answer.kind === 'ruling') {
    const withdrawn =
      answer.withdrawn === null ? '' : ` (withdrawn ${minute(answer.withdrawn.at)})`;
    return `  ${minute(answer.at)}  ruling ${answer.id}: ${answer.text}${answererText(answer.by)}${via}${withdrawn}`;
  }
  return `  ${minute(answer.at)}  ${answer.runId.slice(0, 8)}  ${answer.node ?? '(node not recorded)'}  ${answerText(answer)}${via}`;
}

/** The item read as lines a terminal prints, each section saying `none` when empty. */
export function itemReadLines(read: ItemRead): string[] {
  const lines = [`Item ${read.item.key} (${read.item.projectKey})`, '', 'Runs:'];
  if (read.runs.length === 0) lines.push('  none');
  for (const run of read.runs) lines.push(...runLines(run));
  if (read.starts.length > 0) {
    lines.push('', 'Starts with no run yet:');
    for (const start of read.starts) lines.push(...startLines(start));
  }
  lines.push('', 'Open questions:');
  if (read.questions.length === 0) lines.push('  none');
  for (const question of read.questions) lines.push(...attentionItemLines(question, 'brief'));
  const runs = read.degraded.flatMap(report => ('runId' in report ? [report.runId] : []));
  if (runs.length > 0)
    lines.push(
      `  ${String(runs.length)} run(s) in this item could not be read: ${runs.join(', ')}`
    );
  lines.push('', 'Answers:');
  if (read.answers.length === 0) lines.push('  none');
  for (const answer of read.answers) lines.push(answerLine(answer));
  const rulings = read.degraded.flatMap(report => ('rulingId' in report ? [report.rulingId] : []));
  if (rulings.length > 0)
    lines.push(
      `  ${String(rulings.length)} ruling(s) on this item could not be read: ${rulings.join(', ')}`
    );
  return lines;
}
