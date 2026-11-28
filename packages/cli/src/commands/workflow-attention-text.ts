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
  type AttentionQueueItemWithoutRun,
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
import { PACK_SETTING_ORIGIN_TEXT } from '@archon/workflows/pack-settings';
import type { FileSettingRefusal } from '@archon/workflows/schemas/pack-settings';
import type { StoppedRefusal } from '@archon/workflows/schemas/run-metadata';
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
  // An ask that has no recommendation says so, and why when its stage said, so a reader
  // does not look for one.
  if (item.askedIn !== undefined && item.recommendation === undefined)
    lines.push(
      item.noRecommendation === undefined
        ? 'recommended: none (choose an option)'
        : `no recommendation: ${oneLine(item.noRecommendation)}`
    );
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

/** Why a start was refused before launch, by the code its stop recorded. */
const REFUSAL_REASONS: Record<StoppedRefusal['reason'], string> = {
  checkout_refused: 'the checkout could not be handed on',
  inputs_unmapped: 'an input the binding maps named nothing',
  link_refused: 'the items it links to could not be read or hold no such link',
  no_default_provider: 'no default AI provider is set',
  file_setting_missing: 'a pack file setting it reads names no file',
  run_as_user_failed: "the binding's run-as user could not be found",
  run_configuration_failed: "the item's or the binding's run configuration could not be read",
  launch_preparation_failed: 'preparing its launch failed',
};

/**
 * What starts refused before launch say, wherever they show: the causing stage's own output,
 * `workflow get`, the item read and attention. Each names its receipt for `trigger inspect`.
 */
export function refusedStartLines(refused: readonly StoppedRefusal[]): string[] {
  return refused.flatMap(start => [
    `the start of ${start.workflow} (binding ${start.bindingId}) was refused before launch at ${start.refusedAt}: ${start.fileSetting === undefined ? REFUSAL_REASONS[start.reason] : fileSettingReason(start.fileSetting)}`,
    ...refusalFixLines(start),
    `see the refusal: archon trigger inspect ${start.receiptId}`,
  ]);
}

/** What clears a refusal, for the reasons whose fix the text can name. */
function refusalFixLines({
  reason,
  fileSetting,
}: {
  reason: string;
  fileSetting?: FileSettingRefusal;
}): string[] {
  if (reason === 'no_default_provider') return ['set one: archon ai default <provider>'];
  return fileSetting === undefined ? [] : [fileSettingFix(fileSetting)];
}

/**
 * A supplied value beats the project file and validate never sees it, so only the binding
 * that supplies it can change it; any other origin the project file overrides.
 */
function fileSettingFix({ setting, origin }: FileSettingRefusal): string {
  return origin === 'supplied'
    ? `restore the file, or change the value the binding supplies for '${setting}' in its inputs`
    : `restore the file, or set '${setting}' to an existing file under 'settings:' in the project's .archon/packs/ file; archon validate workflows checks it`;
}

function fileSettingReason(file: FileSettingRefusal): string {
  return `pack file setting '${file.setting}' names ${file.path}, which does not exist or is not a file (value from ${PACK_SETTING_ORIGIN_TEXT[file.origin]})`;
}

/** How a stopped item's run ended: a run that settled asks may have no outcome. */
const ended = (workflow: string, outcome: string | null): string =>
  outcome === null ? `${workflow} ended` : `${workflow} ended as '${outcome}'`;

/** A path as one shell word: quoted only when it holds a character a shell would split on. */
const shellWord = (text: string): string =>
  /^[\w@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * What a stopped item says: the stage, the outcome it ended in and its summary, and the
 * commands that read the item and move it, each working from any directory: the item is
 * read through its run, and a start names the project's checkout. A new step closes it; a
 * run of a workflow that observes the item does not, and its end may have started one.
 */
function stoppedLines(item: Extract<AttentionQueueItem, { kind: 'stopped' }>): string[] {
  const { runId, workflow, outcome } = item.stoppedIn;
  const { limit, refused } = item;
  // A limit and refusals before launch can come from one run's end; each keeps its lines.
  const lines =
    limit !== undefined
      ? [
          `${ended(workflow, outcome)}; its start of ${limit.workflow} was refused at start limit '${limit.name}': ${String(limit.used)} of ${String(limit.starts + limit.granted)} starts used`,
          `one more start: an asks-settled binding that grants '${limit.name}', or a start of ${limit.workflow} by hand`,
        ]
      : [
          // A refused start says only what was refused: others the end caused may have started.
          refused === undefined
            ? `${ended(workflow, outcome)}; no step followed it and it left no ask (a stage that observes the item moves it on not at all)`
            : `${ended(workflow, outcome)}; ${refused.length === 1 ? 'a start it caused was' : `${String(refused.length)} starts it caused were`} refused`,
        ];
  lines.push(...refusedStartLines(refused ?? []));
  if (item.summary !== null) lines.push(`summary: ${oneLine(item.summary)}`);
  lines.push(
    `show the run: ${command(`get ${runId}`)}`,
    `read the item: ${command(`runs --item-of ${runId}`)}`
  );
  if (item.item !== undefined) {
    const cwd = item.checkout === null ? '' : ` --cwd ${shellWord(item.checkout)}`;
    // Not a refused start's workflow: a bare run lacks the inputs and checkout its binding
    // would have passed.
    const next = limit?.workflow;
    const start = command(
      `run ${next === undefined ? '<workflow>' : shellWord(next)} --item ${shellWord(item.item.key)}${cwd}`
    );
    lines.push(
      `run a step on it, which closes this (a workflow that observes the item does not): ${start}${item.checkout === null ? ", from the item's project" : ''}`
    );
  }
  return lines;
}

/** A stopped item's lines: a failed run's, or a stop's. */
function stoppedItemLines(item: Extract<AttentionQueueItem, { kind: 'stopped' }>): string[] {
  return item.failed === undefined ? stoppedLines(item) : failedLines(item, item.failed);
}

/**
 * A failed run that is the newest on its item: its error, and the restarts. A restart from
 * the run's record repeats its inputs; naming the workflow passes others. A run that failed
 * with an unknown outcome, on an item or not, is resumed or abandoned once its operator
 * checked what the node did; a restart would not close it.
 */
function failedLines(
  item: Extract<AttentionQueueItem, { kind: 'stopped' }>,
  { error, outcomeUnknown }: NonNullable<Extract<AttentionQueueItem, { kind: 'stopped' }>['failed']>
): string[] {
  const { runId, workflow } = item.stoppedIn;
  const failed = `${workflow} failed${error === null ? '' : `: ${oneLine(error)}`}`;
  const show = `show the run: ${command(`get ${runId}`)}`;
  const readItem = `read the item: ${command(`runs --item-of ${runId}`)}`;
  if (outcomeUnknown !== undefined)
    return [
      failed,
      `${outcomeUnknown.length === 0 ? 'its outcome is' : `the outcome of ${outcomeUnknown.join(', ')} is`} unknown, so nothing continues it by itself`,
      `check what it did, then resume it with ${command(`resume ${runId}`)}, or abandon it with ${command(`abandon ${runId}`)}`,
      show,
      ...(item.item === undefined ? [] : [readItem]),
    ];
  return [
    failed,
    `start it again from its record, which closes this: ${command(`run --supersedes ${runId}`)}`,
    `or with other inputs: ${command(`run ${shellWord(workflow)} --supersedes ${runId} --input <name>=<value>`)}`,
    show,
    readItem,
  ];
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
        `${item.run.node}: ${limitName(item)} reached; tries again by itself at ${item.resetAt}`,
        `retry sooner: ${command(`resume ${run.id}`)}, or stop it: ${command(`abandon ${run.id}`)}`,
      ];
    case 'unreadable':
      return [
        `needs a look: ${item.detail}`,
        `show more: ${command(`get ${run.id}`)}, then resume or abandon it`,
      ];
    case 'owner_lost': {
      // It still holds what it took: its item, and the slot of a resource it runs under.
      const holding = item.item === undefined ? '' : `, holding item ${item.item.key}`;
      if (item.start !== undefined)
        return [
          `admitted but not started, and no process runs it${holding}`,
          `start it: archon trigger execute ${item.start.requestId} --host ${item.start.hostId}, or end it: ${command(`abandon ${run.id}`)}`,
        ];
      if (item.continuation !== undefined)
        return [
          `due to continue, but ${item.continuation.wakers === 'none_recorded' ? 'nothing on this install resumes continuations' : 'the process that resumed continuations here is gone'}${holding}`,
          `start a waker: archon serve, ${command('wake --watch')} or ${command('wake schedule install')}; or end it: ${command(`abandon ${run.id}`)}`,
        ];
      return [
        `${item.observedStatus} but its owner is gone${holding}`,
        `continue it: ${command(`resume ${run.id}`)}, or end it: ${command(`abandon ${run.id}`)}`,
      ];
    }
  }
}

/**
 * The line that heads an item: the paused run that holds it, or, for an item no run
 * holds, its ref as an open ask with the item it belongs to and when it opened.
 */
function headingLine(item: AttentionQueueItem): string {
  const project = item.project?.name ?? '(no project)';
  const mark = item.priority ? '  priority' : '';
  if (isHeldByRun(item)) {
    const paused =
      item.kind === 'owner_lost'
        ? item.continuation === undefined
          ? 'owner gone'
          : 'due, no waker'
        : item.pausedAt === null
          ? 'pause time not recorded'
          : `paused ${formatAge(item.pausedAt)} ago`;
    return `  ${item.run.id}  ${item.run.workflow}  ${project}  ${paused}${mark}`;
  }
  const key = item.item === undefined ? '' : `  item ${item.item.key}`;
  const [what, event] = withoutRunHeading[item.kind];
  const at =
    item.pausedAt === null
      ? `${event} time not recorded`
      : `${event} ${formatAge(item.pausedAt)} ago`;
  return `  ${item.ref}  ${what}  ${project}${key}  ${at}${mark}`;
}

/** What the heading of an item no run holds calls it, and the event its time is of. */
const withoutRunHeading: Record<AttentionQueueItemWithoutRun['kind'], [string, string]> = {
  attention: ['open ask', 'opened'],
  overdue_wait: ['overdue wait', 'opened'],
  stopped: ['stopped', 'ended'],
  refused_start: ['refused start', 'refused'],
  preparation_lost: ['preparer gone', 'claimed'],
  unreadable_start: ['unreadable start', 'queued'],
};

/** An item's heading line, then what its run is part of and its labels. */
function headLines(item: AttentionQueueItem): string[] {
  const run = isHeldByRun(item) ? item.run : undefined;
  const lines = [headingLine(item)];
  if (run !== undefined && run.fanOut !== null)
    lines.push(`    fan-out item ${String(run.fanOut.index)} of run ${run.fanOut.parentRunId}`);
  else if (run !== undefined && run.parentRunId !== null)
    lines.push(`    child of run ${run.parentRunId}`);
  const labels = Object.entries(item.labels);
  if (labels.length > 0)
    lines.push(`    labels: ${labels.map(([key, value]) => `${key}=${value}`).join(', ')}`);
  return lines;
}

/** One queue item as a block of text lines. */
export function attentionItemLines(
  item: AttentionQueueItem,
  detail: AttentionItemDetail
): string[] {
  // No run holds it, so no run command answers it: it is answered by its ref.
  const body = isHeldByRun(item) ? itemBody(item, detail) : withoutRunBody(item);
  return [...headLines(item), ...body.map(line => `    ${line}`)];
}

type UsageLimitItem = Extract<AttentionQueueItem, { kind: 'usage_limit' }>;

/** The limit a usage-limit item waits on, by its provider when the wait recorded one. */
const limitName = (item: UsageLimitItem): string =>
  item.provider === undefined
    ? 'usage or rate limit (provider not recorded)'
    : `${item.provider} usage or rate limit`;

/** The usage-limit items one entry of the list holds, from the first of them. */
type LimitGroup = [UsageLimitItem, ...UsageLimitItem[]];

/**
 * The list as text blocks, one per entry. The usage-limit items of one provider are one
 * entry, at the place of the first of them, naming each run it holds: one limit is one
 * thing to act on. Every other item is its own entry, and so is a usage-limit item whose
 * wait recorded no provider, since nothing says which limit holds it. The provider is the
 * whole key: the engine cannot tell two credentials of one provider apart, and each run
 * keeps its own retry time.
 */
export function attentionListBlocks(items: readonly AttentionQueueItem[]): string[][] {
  const limits = new Map<string, LimitGroup>();
  const entries: (AttentionQueueItem | LimitGroup)[] = [];
  for (const item of items) {
    if (item.kind !== 'usage_limit') {
      entries.push(item);
      continue;
    }
    const held = item.provider === undefined ? undefined : limits.get(item.provider);
    if (held !== undefined) {
      held.push(item);
      continue;
    }
    const group: LimitGroup = [item];
    if (item.provider !== undefined) limits.set(item.provider, group);
    entries.push(group);
  }
  return entries.map(entry =>
    Array.isArray(entry) ? usageLimitLines(entry) : attentionItemLines(entry, 'brief')
  );
}

/** One limit and the runs it holds, each with its node, retry time and commands. */
function usageLimitLines(group: LimitGroup): string[] {
  const runs = group.length === 1 ? '1 run' : `${String(group.length)} runs`;
  const lines = [`  ${limitName(group[0])}, holding ${runs}`];
  for (const item of group)
    lines.push(
      ...headLines(item).map(line => `  ${line}`),
      `      ${item.run.node}: tries again by itself at ${item.resetAt}`,
      `      retry sooner: ${command(`resume ${item.run.id}`)}, or stop it: ${command(`abandon ${item.run.id}`)}`
    );
  return lines;
}

/** What an item no run holds says under its heading line; a run's kinds never reach it. */
function withoutRunBody(item: AttentionQueueItem): string[] {
  switch (item.kind) {
    case 'overdue_wait':
      return overdueWaitLines(item);
    case 'stopped':
      return stoppedItemLines(item);
    case 'refused_start':
      return refusedStartItemLines(item);
    case 'preparation_lost':
      return preparationLostLines(item);
    case 'unreadable_start':
      return unreadableStartLines(item);
    case 'attention':
      return refItemLines(item);
    default:
      return [];
  }
}

/**
 * A start no run caused that was refused and is its item's newest step: what it was for,
 * why, and what moves the item on. A run on the item, or the binding starting on it, closes it.
 */
function refusedStartItemLines(
  item: Extract<AttentionQueueItem, { kind: 'refused_start' }>
): string[] {
  const { receiptId, bindingId, workflow, itemKey, reason, limit, fileSetting } = item.start;
  const what = `the start of ${workflow ?? 'its workflow'} on item ${itemKey} (binding ${bindingId}) was refused`;
  const lines =
    limit !== undefined
      ? [
          `${what} at start limit '${limit.name}': ${String(limit.used)} of ${String(limit.starts + limit.granted)} starts used`,
          `one more start: an asks-settled binding that grants '${limit.name}', or a start of ${limit.workflow} by hand`,
        ]
      : [
          `${what}: ${fileSetting === undefined ? refusalText(reason) : fileSettingReason(fileSetting)}`,
        ];
  lines.push(...refusalFixLines(item.start));
  lines.push(`see the refusal: archon trigger inspect ${receiptId}`);
  return lines;
}

/** A stored refusal code as text; a code a newer binary wrote is shown as it is. */
function refusalText(reason: string): string {
  if (reason === 'rejected_by_source') return 'its source rejected the event';
  return Object.hasOwn(REFUSAL_REASONS, reason)
    ? REFUSAL_REASONS[reason as StoppedRefusal['reason']]
    : reason;
}

/**
 * A binding start whose preparer is gone: what it was for, and the recovery that returns it
 * to pending so the next drain of its host prepares it again.
 */
function preparationLostLines(
  item: Extract<AttentionQueueItem, { kind: 'preparation_lost' }>
): string[] {
  const { receiptId, bindingId, hostId, workflow, itemKey, ownerId } = item.start;
  const on = itemKey === null ? '' : ` on item ${itemKey}`;
  return [
    `the start of ${workflow ?? 'its workflow'}${on} (binding ${bindingId}) is still preparing, and the process preparing it is gone`,
    `return it to pending: archon trigger recover-preparation ${receiptId} ${bindingId} --owner ${ownerId} --yes`,
    `then prepare it: archon trigger drain --host ${hostId ?? '<host-id>'}`,
    `show the receipt: archon trigger inspect ${receiptId}`,
  ];
}

/**
 * A queued request whose launch does not read: what it holds behind it, and the withdrawal
 * that frees them.
 */
function unreadableStartLines(
  item: Extract<AttentionQueueItem, { kind: 'unreadable_start' }>
): string[] {
  const { requestId, resource, hostId, behind } = item.start;
  return [
    behind === 0
      ? `a start queued on ${resource} (host ${hostId}) cannot be read; nothing is queued behind it yet`
      : `a start queued on ${resource} (host ${hostId}) cannot be read, so ${behind === 1 ? 'the start queued behind it waits' : `the ${String(behind)} starts queued behind it wait`}`,
    `withdraw it: archon trigger withdraw ${requestId}`,
  ];
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
      // It still holds what it took: its item, and the slot of a resource it runs under.
      const held = line.item == null ? '' : ` It still holds item ${line.item}.`;
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
