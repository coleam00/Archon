/**
 * The text of the attention queue for a reader at a terminal, person or agent: one owner
 * for what an item and a stream line say, shared by the list, the single read and the
 * watch. An item's text is enough to act on by itself: what is asked, what is recommended
 * and why, what each option does, and the exact command that answers this occurrence.
 * `--json` remains the complete machine form.
 */
import type { AttentionQueueItem, AttentionQueueScope } from '@archon/workflows/attention-queue';
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import { spellWorkflowCommand } from '@archon/workflows/deps';
import {
  describeAttentionRecommendation,
  legacyOccurrenceStep,
  type AttentionAnswerer,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowNotice } from '@archon/workflows/workflow-notice';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { formatAge } from './workflow-shared';

/**
 * How much of an item its text carries. The list and the watch print a `brief`: the
 * question's first line and a pointer to the rest. The single read prints the `full`
 * message. Both carry the recommendation, the options and the answer commands.
 */
export type AttentionItemDetail = 'brief' | 'full';

const BRIEF_QUESTION_LENGTH = 200;

const command = (text: string): string => spellWorkflowCommand(CLI_WORKFLOW_SURFACE, text);

/** Text on one line, so one fact stays one line of the block. */
const oneLine = (text: string): string => text.split(/\s+/u).join(' ').trim();

/** The first line of a message that says anything, cut to a length a block can carry. */
function firstLine(message: string): string {
  const line = message.split('\n').find(candidate => candidate.trim() !== '') ?? '';
  const text = line.trim();
  return text.length > BRIEF_QUESTION_LENGTH
    ? `${text.slice(0, BRIEF_QUESTION_LENGTH - 1)}…`
    : text;
}

const question = (message: string, detail: AttentionItemDetail): string =>
  detail === 'full' ? message : firstLine(message);

type Ask = Extract<AttentionQueueItem, { kind: 'attention' }>;

/** The command that answers `ask` in its form, pinned to the occurrence the reader saw. */
function answerCommand(ask: Ask): string {
  const pin = `--occurrence ${ask.occurrence}`;
  switch (ask.form) {
    case 'message':
      return command(`answer ${ask.runId} ${pin} --text <your answer>`);
    case 'approval':
      return command(`respond ${ask.runId} approve|reject ${pin} [text]`);
    case 'select':
      return (
        command(`respond ${ask.runId} <option> ${pin} [text]`) +
        (ask.other === true ? " ('other' needs text)" : '')
      );
    case 'multi_select':
      return command(
        `answer ${ask.runId} ${pin} --choose <option> [--choose <option>]… [--text <text>]`
      );
  }
}

/** An attention wait: what is asked, recommended and offered, and how to answer it. */
function askLines(ask: Ask, detail: AttentionItemDetail): string[] {
  const lines = [`${ask.node}: ${question(ask.message, detail)}`];
  // A wait paused before answers existed takes none; it resumes.
  if (legacyOccurrenceStep(ask.occurrence) !== undefined)
    return [...lines, `when it is done, resume: ${command(`resume ${ask.runId}`)}`];
  const { recommendation } = ask;
  if (recommendation !== undefined)
    lines.push(`recommended: ${oneLine(describeAttentionRecommendation(recommendation))}`);
  for (const option of ask.options) {
    const label = option.label === undefined ? '' : ` (${option.label})`;
    const does = option.does === undefined ? '' : `: ${oneLine(option.does)}`;
    lines.push(`option ${option.id}${label}${does}`);
  }
  if (recommendation !== undefined)
    lines.push(
      `accept the recommendation: ${command(`respond ${ask.runId} --recommended --occurrence ${ask.occurrence} [--text <why>]`)}`
    );
  lines.push(`answer: ${answerCommand(ask)}`);
  if (detail === 'brief') lines.push(`full question: ${command(`attention ${ask.runId}`)}`);
  return lines;
}

/** What an item of each kind says under its heading line. */
function itemBody(item: AttentionQueueItem, detail: AttentionItemDetail): string[] {
  switch (item.kind) {
    case 'attention':
      return askLines(item, detail);
    case 'awaiting_response':
      return [
        `gate '${item.node}': ${question(item.message, detail)}`,
        `answer: ${command(`approve ${item.runId} --occurrence ${item.occurrence} [comment]`)}, or reject or respond <decision> the same way`,
        ...(detail === 'brief' ? [`full question: ${command(`attention ${item.runId}`)}`] : []),
      ];
    case 'usage_limit':
      return [
        `${item.node}: provider usage or rate limit reached; tries again by itself at ${item.resetAt}`,
        `retry sooner: ${command(`resume ${item.runId}`)}, or stop it: ${command(`abandon ${item.runId}`)}`,
      ];
    case 'unreadable':
      return [
        `needs a look: ${item.detail}`,
        `show more: ${command(`get ${item.runId}`)}, then resume or abandon it`,
      ];
  }
}

/** One queue item as a block of text lines. */
export function attentionItemLines(
  item: AttentionQueueItem,
  detail: AttentionItemDetail
): string[] {
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
  for (const line of itemBody(item, detail)) lines.push(`    ${line}`);
  return lines;
}

type RunLine = Extract<AttentionStreamLine, { runId: string }>;

/** What the run is part of, as a trailing sentence; empty when the stream could not read it. */
function runContextText(line: RunLine): string {
  if (line.workflow === null) return '';
  return line.parentRunId === null
    ? ` Workflow ${line.workflow}.`
    : ` Workflow ${line.workflow}, child of run ${line.parentRunId}.`;
}

/** A run that ended; one that needs a look also says which command shows more. */
function terminalText(line: Extract<AttentionStreamLine, { type: 'terminal' }>): string {
  const outcome = line.outcome === null ? '' : ` (${line.outcome})`;
  const cause =
    line.cause === null
      ? ''
      : `: node ${line.cause.node} (${line.cause.errorClass ?? 'error class not recorded'})`;
  const more =
    line.status === 'failed' || line.outcome === 'failed'
      ? ` Show more with ${command(`get ${line.runId}`)}.`
      : '';
  return `Run ${line.runId} ${line.status}${outcome}${cause}.${runContextText(line)}${more}`;
}

/** Who answered, as a trailing clause: a declared name is marked as the claim it is. */
function answererText(answeredBy: AttentionAnswerer | null): string {
  if (answeredBy === null) return '';
  return 'declared' in answeredBy
    ? ` by ${answeredBy.declared} (self-declared)`
    : ` by user ${answeredBy.userId}`;
}

/** A notice as one line short enough to read aloud: when, what it said, its labels. */
export function noticeText(notice: Pick<WorkflowNotice, 'at' | 'labels' | 'text'>): string {
  const time = new Date(notice.at);
  const at = Number.isNaN(time.getTime()) ? notice.at : `${time.toISOString().slice(0, 16)}Z`;
  const labels = Object.entries(notice.labels).map(([key, value]) => `${key}=${value}`);
  return [at, notice.text, ...(labels.length > 0 ? [labels.join(' ')] : [])].join('  ');
}

/** The text for one stream line; none for a bookmark. */
export function attentionStreamText(
  line: Exclude<AttentionStreamLine, { type: 'error' }>,
  scope: AttentionQueueScope
): string[] {
  switch (line.type) {
    case 'attention':
      return [
        line.snapshot ? 'Needs attention:' : 'Needs attention now:',
        ...attentionItemLines(line.item, 'brief'),
      ];
    case 'resolved':
      return [
        (line.reason === 'answered'
          ? `Run ${line.runId} was answered${line.answeredVia === null ? '' : ` via ${line.answeredVia}`}${answererText(line.answeredBy)}.`
          : `Run ${line.runId} no longer needs attention.`) + runContextText(line),
      ];
    case 'unmatched':
      return [`Run ${line.runId} no longer matches the label filter.${runContextText(line)}`];
    case 'terminal':
      return [terminalText(line)];
    case 'resumed':
      return [`Run ${line.runId} resumed (${line.status}).${runContextText(line)}`];
    case 'notice':
      return [noticeText(line)];
    case 'owner_lost':
      return [
        `Run ${line.runId} is ${line.observedStatus} but its owner is gone.${runContextText(line)} ` +
          `Show more with ${command(`get ${line.runId}`)}, or abandon it with ${command(`abandon ${line.runId}`)}.`,
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
