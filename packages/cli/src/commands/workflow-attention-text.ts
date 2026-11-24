/**
 * The text of the attention queue for a reader at a terminal, person or agent: one owner
 * for what an item and a stream line say, shared by the list, the single read and the
 * watch. An item's text is enough to act on by itself: what is asked, what is recommended
 * and why, what each option does, and the exact command that answers this occurrence.
 * `--json` remains the complete machine form.
 */
import {
  isHeldByRun,
  type AttentionQueueItem,
  type AttentionQueueScope,
  type RunAttentionQueueItem,
} from '@archon/workflows/attention-queue';
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
 * How much of a paused run's item its text carries. The list and the watch print a `brief`:
 * the question's first line and a pointer to the rest. The single read prints the `full`
 * message. Both carry the recommendation, the options and the answer commands. An ask no
 * run holds always prints whole, since no single read exists for it.
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
/** A question a paused run holds, which the run's answer commands answer. */
type RunAsk = Extract<RunAttentionQueueItem, { kind: 'attention' }>;

/** The command that answers `ask` in its form, pinned to the occurrence the reader saw. */
function answerCommand(ask: RunAsk): string {
  const { id, occurrence } = ask.run;
  const pin = `--occurrence ${occurrence}`;
  switch (ask.form) {
    case 'message':
      return command(`answer ${id} ${pin} --text <your answer>`);
    case 'approval':
      return command(`respond ${id} approve|reject ${pin} [text]`);
    case 'select':
      return (
        command(`respond ${id} <option> ${pin} [text]`) +
        (ask.other === true ? " ('other' needs text)" : '')
      );
    case 'multi_select':
      return command(`answer ${id} ${pin} --choose <option> [--choose <option>]… [--text <text>]`);
  }
}

/** What a question recommends and offers. */
function offerLines(ask: Ask): string[] {
  const lines: string[] = [];
  if (ask.recommendation !== undefined)
    lines.push(`recommended: ${oneLine(describeAttentionRecommendation(ask.recommendation))}`);
  for (const option of ask.options) {
    const label = option.label === undefined ? '' : ` (${option.label})`;
    const does = option.does === undefined ? '' : `: ${oneLine(option.does)}`;
    const cost = option.cost === undefined ? '' : ` (cost: ${oneLine(option.cost)})`;
    lines.push(`option ${option.id}${label}${does}${cost}`);
  }
  return lines;
}

/** An attention wait: what is asked, recommended and offered, and how to answer it. */
function askLines(ask: RunAsk, detail: AttentionItemDetail): string[] {
  const { id, node, occurrence } = ask.run;
  const lines = [`${node}: ${question(ask.message, detail)}`];
  // A wait paused before answers existed takes none; it resumes.
  if (legacyOccurrenceStep(occurrence) !== undefined)
    return [...lines, `when it is done, resume: ${command(`resume ${id}`)}`];
  lines.push(...offerLines(ask));
  if (ask.recommendation !== undefined)
    lines.push(
      `accept the recommendation: ${command(`respond ${id} --recommended --occurrence ${occurrence} [--text <why>]`)}`
    );
  lines.push(`answer: ${answerCommand(ask)}`);
  if (detail === 'brief') lines.push(`full question: ${command(`attention ${id}`)}`);
  return lines;
}

/**
 * An item no run holds, such as an ask a completed run left: answered by its ref. Its
 * question and context are printed whole in every form: no other command reads an ask a
 * finished run left, so a cut here would be an answer given without knowing what was cut.
 */
function refItemLines(item: Ask): string[] {
  const lines = [item.message.trim()];
  if (item.askedIn !== undefined)
    lines.push(`left by run ${item.askedIn.runId} (${item.askedIn.workflow}), which completed`);
  if (item.context !== undefined) {
    const [head = '', ...rest] = item.context.trim().split('\n');
    lines.push(`context: ${head}`, ...rest.map(line => `  ${line}`));
  }
  // An ask that has no recommendation says so, so a reader does not look for one.
  if (item.askedIn !== undefined && item.recommendation === undefined)
    lines.push('recommended: none (choose an option)');
  lines.push(...offerLines(item));
  for (const artifact of item.artifacts ?? [])
    lines.push(`artifact: ${artifact.path} (run ${artifact.run_id})`);
  if (item.recommendation !== undefined)
    lines.push(
      `accept the recommendation: ${command(`answer --ref ${item.ref} --recommended [--text <why>]`)}`
    );
  lines.push(
    `answer: ${command(`answer --ref ${item.ref} --choose <option> [--text <text>]`)}` +
      (item.other === true ? " ('other' needs text)" : '')
  );
  if (item.askedIn !== undefined)
    lines.push(`withdraw: ${command(`answer --withdraw ${item.ref}`)}`);
  return lines;
}

/** What an overdue wait says: what the item waits for, since when, and how it closes. */
function overdueWaitLines(item: Extract<AttentionQueueItem, { kind: 'overdue_wait' }>): string[] {
  return [
    `waits for ${item.waits.map(wait => `'${wait.event}' about ${wait.about}`).join(' or ')}, due ${item.deadline}`,
    `left by run ${item.waitingIn.runId} (${item.waitingIn.workflow}), which completed; nothing is held while it waits`,
    `the event still meets it when it arrives; run ${item.waitingIn.workflow} on the item again to replace it, or withdraw it: ${command(`answer --withdraw ${item.ref}`)}`,
  ];
}

/** A path as one shell word: quoted only when it holds a character a shell would split on. */
const shellWord = (text: string): string =>
  /^[\w@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * What a stopped item says: the stage, the outcome it ended in and its summary, and the
 * commands that read the item and move it, each working from any directory: the item is
 * read through its run, and a start names the project's checkout. A new run closes it.
 */
function stoppedLines(item: Extract<AttentionQueueItem, { kind: 'stopped' }>): string[] {
  const { runId, workflow, outcome } = item.stoppedIn;
  const lines = [`${workflow} ended as '${outcome}'; nothing started and it left no ask`];
  if (item.summary !== null) lines.push(`summary: ${oneLine(item.summary)}`);
  lines.push(
    `show the run: ${command(`get ${runId}`)}`,
    `read the item: ${command(`runs --item-of ${runId}`)}`
  );
  if (item.item !== undefined) {
    const cwd = item.checkout === null ? '' : ` --cwd ${shellWord(item.checkout)}`;
    const start = command(`run <workflow> --item ${shellWord(item.item.key)}${cwd}`);
    lines.push(
      `run a stage on it, which closes this: ${start}${item.checkout === null ? ", from the item's project" : ''}`
    );
  }
  return lines;
}

/** What an item a paused run holds says under its heading line. */
function itemBody(item: RunAttentionQueueItem, detail: AttentionItemDetail): string[] {
  const { run } = item;
  switch (item.kind) {
    case 'attention':
      return askLines(item, detail);
    case 'awaiting_response':
      return [
        `gate '${item.run.node}': ${question(item.message, detail)}`,
        `answer: ${command(`approve ${run.id} --occurrence ${item.run.occurrence} [comment]`)}, or reject or respond <decision> the same way`,
        ...(detail === 'brief' ? [`full question: ${command(`attention ${run.id}`)}`] : []),
      ];
    case 'usage_limit':
      return [
        `${item.run.node}: provider usage or rate limit reached; tries again by itself at ${item.resetAt}`,
        `retry sooner: ${command(`resume ${run.id}`)}, or stop it: ${command(`abandon ${run.id}`)}`,
      ];
    case 'unreadable':
      return [
        `needs a look: ${item.detail}`,
        `show more: ${command(`get ${run.id}`)}, then resume or abandon it`,
      ];
    case 'owner_lost':
      return [
        `${item.observedStatus} but its owner is gone, holding item ${item.item?.key ?? '(unread)'}: later starts of ${run.workflow} on it wait behind it`,
        `continue it: ${command(`resume ${run.id}`)}, or end it: ${command(`abandon ${run.id}`)}`,
      ];
  }
}

/**
 * The line that heads an item: the paused run that holds it, or, for an item no run
 * holds, its ref as an open ask with the item it belongs to and when it opened.
 */
function headingLine(item: AttentionQueueItem): string {
  const project = item.project?.name ?? '(no project)';
  if (isHeldByRun(item)) {
    const paused =
      item.kind === 'owner_lost'
        ? 'owner gone'
        : item.pausedAt === null
          ? 'pause time not recorded'
          : `paused ${formatAge(item.pausedAt)} ago`;
    return `  ${item.run.id}  ${item.run.workflow}  ${project}  ${paused}`;
  }
  const opened =
    item.pausedAt === null ? 'open time not recorded' : `opened ${formatAge(item.pausedAt)} ago`;
  const key = item.item === undefined ? '' : `  item ${item.item.key}`;
  if (item.kind === 'stopped') {
    const ended =
      item.pausedAt === null ? 'end time not recorded' : `ended ${formatAge(item.pausedAt)} ago`;
    return `  ${item.ref}  stopped  ${project}${key}  ${ended}`;
  }
  const what = item.kind === 'overdue_wait' ? 'overdue wait' : 'open ask';
  return `  ${item.ref}  ${what}  ${project}${key}  ${opened}`;
}

/** One queue item as a block of text lines. */
export function attentionItemLines(
  item: AttentionQueueItem,
  detail: AttentionItemDetail
): string[] {
  const run = isHeldByRun(item) ? item.run : undefined;
  const lines = [headingLine(item)];
  if (run !== undefined && run.fanOut !== null)
    lines.push(`    fan-out item ${String(run.fanOut.index)} of run ${run.fanOut.parentRunId}`);
  else if (run !== undefined && run.parentRunId !== null)
    lines.push(`    child of run ${run.parentRunId}`);
  const labels = Object.entries(item.labels);
  if (labels.length > 0)
    lines.push(`    labels: ${labels.map(([key, value]) => `${key}=${value}`).join(', ')}`);
  // No run holds it, so no run command answers it: it is answered by its ref.
  const body = isHeldByRun(item)
    ? itemBody(item, detail)
    : item.kind === 'overdue_wait'
      ? overdueWaitLines(item)
      : item.kind === 'stopped'
        ? stoppedLines(item)
        : refItemLines(item);
  for (const line of body) lines.push(`    ${line}`);
  return lines;
}

/** How a line names the item that closed: by the run that held it, else by its ref. */
function closedItemName(line: { ref: string; runId?: string }): string {
  return line.runId === undefined ? `Item ${line.ref}` : `Run ${line.runId}`;
}

type RunContext = Pick<Extract<AttentionStreamLine, { runId: string }>, 'workflow' | 'parentRunId'>;

/** What the run is part of, as a trailing sentence; empty when the stream has no run to read. */
function runContextText(line: RunContext): string {
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
export function answererText(answeredBy: AttentionAnswerer | null): string {
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

/** How an item closed, as the rest of the sentence that names it. */
function closedText(line: Extract<AttentionStreamLine, { type: 'resolved' }>): string {
  switch (line.reason) {
    case 'answered':
      return `was answered${line.answeredVia === null ? '' : ` via ${line.answeredVia}`}${answererText(line.answeredBy)}${line.answeredFromRun === null ? '' : ` from run ${line.answeredFromRun.runId} (node ${line.answeredFromRun.nodePath})`}.`;
    case 'withdrawn':
      return 'no longer needs attention.';
    case 'replaced':
      return `was replaced by the asks of run ${line.replacedByRunId}.`;
    case 'no_longer_listed':
      return 'is no longer listed.';
  }
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
      return [`${closedItemName(line)} ${closedText(line)}${runContextText(line)}`];
    case 'unmatched':
      return [`${closedItemName(line)} no longer matches the label filter.${runContextText(line)}`];
    case 'terminal':
      return [terminalText(line), ...(line.reason ?? []).map(reason => `  ${reason}`)];
    case 'resumed':
      return [`Run ${line.runId} resumed (${line.status}).${runContextText(line)}`];
    case 'notice':
      return [noticeText(line)];
    case 'owner_lost': {
      // A run on an item holds it, so the later starts of its workflow on it wait behind it.
      const held =
        line.item == null
          ? ''
          : ` It holds item ${line.item}: later starts of ${line.workflow ?? 'its workflow'} on it wait behind it.`;
      return [
        `Run ${line.runId} is ${line.observedStatus} but its owner is gone.${runContextText(line)}${held} ` +
          `Show more with ${command(`get ${line.runId}`)}, continue it with ${command(`resume ${line.runId}`)}, or abandon it with ${command(`abandon ${line.runId}`)}.`,
      ];
    }
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
