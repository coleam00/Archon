/**
 * The text of an item read (`workflow runs --item`): its runs, open questions and answers,
 * each oldest first. Built from the same `ItemRead` that `--json` prints.
 */
import type { ItemAnswer, ItemRead } from '@archon/workflows/item-read';
import { answererText, attentionItemLines } from './workflow-attention-text';

/** A recorded time to the minute, or the stored text when it does not parse. */
function minute(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : `${time.toISOString().slice(0, 16)}Z`;
}

function answerText(answer: ItemAnswer): string {
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

/** The item read as lines a terminal prints, each section saying `none` when empty. */
export function itemReadLines(read: ItemRead): string[] {
  const lines = [`Item ${read.item.key} (${read.item.projectKey})`, '', 'Runs:'];
  if (read.runs.length === 0) lines.push('  none');
  for (const run of read.runs) {
    const outcome = run.outcome === null ? '' : ` · authored outcome: ${run.outcome}`;
    const ended = run.completedAt === null ? '' : ` → ${minute(run.completedAt)}`;
    lines.push(
      `  ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  ${run.workflow}${outcome}  ${minute(run.startedAt)}${ended}`
    );
  }
  lines.push('', 'Open questions:');
  if (read.questions.length === 0) lines.push('  none');
  for (const question of read.questions) lines.push(...attentionItemLines(question, 'brief'));
  if (read.degraded.length > 0)
    lines.push(
      `  ${String(read.degraded.length)} run(s) in this item could not be read: ${read.degraded.map(report => report.runId).join(', ')}`
    );
  lines.push('', 'Answers:');
  if (read.answers.length === 0) lines.push('  none');
  for (const answer of read.answers) {
    const via = answer.via === null ? '' : ` (via ${answer.via})`;
    lines.push(
      `  ${minute(answer.at)}  ${answer.runId.slice(0, 8)}  ${answer.node ?? '(node not recorded)'}  ${answerText(answer)}${via}`
    );
  }
  return lines;
}
