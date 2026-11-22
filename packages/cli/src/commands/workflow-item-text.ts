/**
 * The text of an item read (`workflow runs --item`): its runs, its starts waiting to start
 * and its refused starts, links, open questions, and answers with rulings, each oldest
 * first. Built from the same `ItemRead` that `--json` prints.
 */
import { describeInstallHold } from '@archon/workflows/schemas/resource-start';
import type {
  ItemAnswer,
  ItemHeldBehind,
  ItemHeldStart,
  ItemQueuedStart,
  ItemRead,
  ItemReadLink,
  ItemRun,
  ItemSkippedStart,
} from '@archon/workflows/item-read';
import { describeOperatorPause } from '@archon/workflows/schemas/operator-pause';
import { landingSourceText } from '@archon/workflows/item-landing';
import { answererText, attentionItemLines } from './workflow-attention-text';

/** A recorded time to the minute, or the stored text when it does not parse. */
function minute(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : `${time.toISOString().slice(0, 16)}Z`;
}

/** What an answer chose and said, with who said it. */
function answeredText(
  answer: Extract<ItemAnswer, { kind: 'attention' | 'ask' }>,
  subject: string
): string {
  if (answer.answer === null) return `${subject}answered (answer not recorded)`;
  const chosen =
    'decisions' in answer.answer
      ? answer.answer.decisions.join(', ')
      : 'decision' in answer.answer
        ? answer.answer.decision
        : undefined;
  const parts = [chosen, answer.answer.text === '' ? undefined : answer.answer.text];
  return `${subject}answered ${parts.filter(part => part !== undefined).join(': ')}${answererText(answer.by)}`;
}

function answerText(answer: Exclude<ItemAnswer, { kind: 'ruling' }>): string {
  switch (answer.kind) {
    case 'gate': {
      const text = answer.text === null || answer.text === '' ? '' : `: ${answer.text}`;
      return `gate ${answer.decision ?? '(decision not recorded)'}${text}`;
    }
    case 'asks_settled':
      return answer.answered === 0
        ? `asks settled: all ${String(answer.withdrawn)} withdrawn, none answered`
        : `asks settled: ${String(answer.answered)} answered, ${String(answer.withdrawn)} withdrawn`;
    case 'ask': {
      const asked = `ask "${answer.question}" `;
      if (answer.withdrawn) return `${asked}withdrawn${answererText(answer.by)}`;
      const means = answer.chosen === null ? '' : ` (${answer.chosen.does})`;
      return `${answeredText(answer, asked)}${means}`;
    }
    case 'attention':
      return answeredText(answer, '');
  }
}

function causeText(cause: ItemRun['cause']): string {
  if (cause === null) return '';
  if (cause.kind === 'run_ended') return ` · after run ${cause.runId.slice(0, 8)} ended`;
  if (cause.kind === 'asks_settled')
    return ` · after the asks of run ${cause.runId.slice(0, 8)} settled`;
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

function skippedLines(start: ItemSkippedStart): string[] {
  const lines = [
    `  ${start.requestId}  ${start.workflow ?? '(launch unreadable)'}  on ${start.resource}, skipped`,
  ];
  if (start.heldBehind) lines.push(...heldBehindLines('refused, held by', start.heldBehind));
  return lines;
}

/**
 * An admitted start whose run has not begun. Only a start nobody runs gets the command that
 * starts it; one this process cannot observe points to the inspection instead.
 */
function awaitingExecutionText(waiting: NonNullable<ItemRun['awaitingExecution']>): string {
  const { executor } = waiting;
  switch (waiting.state) {
    case 'starting':
      // The owner endpoint proves it; the recorded pid is only who it was handed to.
      return 'admitted, starting';
    case 'unowned':
      return `admitted, not started, and no process is running it. Start it: archon trigger execute ${waiting.requestId} --host ${waiting.hostId}`;
    case 'unknown': {
      const where = executor
        ? ` (handed to process ${String(executor.pid)} on ${executor.host})`
        : '';
      return `admitted, not started; this process cannot confirm its executor${where}. Inspect it: archon trigger inspect ${waiting.requestId}`;
    }
  }
}

/**
 * One run, how to read its result when it has one, and how to start it when it was admitted
 * but no process is running it.
 */
function runLines(run: ItemRun): string[] {
  const outcome = run.outcome === null ? '' : ` · authored outcome: ${run.outcome}`;
  const ended = run.completedAt === null ? '' : ` → ${minute(run.completedAt)}`;
  const lines = [
    `  ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  ${run.workflow}${outcome}  ${minute(run.startedAt)}${ended}${causeText(run.cause)}`,
  ];
  // A result can hold at a commit without being readable (a truncated untyped result).
  const holds = run.resultCommit ? `holds at ${run.resultCommit.slice(0, 12)}` : null;
  if (run.hasResult)
    lines.push(
      `            result: archon workflow get ${run.id} --json${holds ? `, ${holds}` : ''}`
    );
  else if (holds) lines.push(`            result: ${holds}`);
  if (run.operatorPause) lines.push(`            ${describeOperatorPause(run.operatorPause)}`);
  if (run.awaitingExecution)
    lines.push(`            ${awaitingExecutionText(run.awaitingExecution)}`);
  if (run.heldBehind)
    lines.push(
      ...heldBehindLines(
        run.status === 'cancelled' ? 'refused, held by' : 'waits behind',
        run.heldBehind
      )
    );
  return lines;
}

/**
 * What admits a start waiting on `hostId`. A CLI run end and each `workflow wake` pass
 * drain the hosts this install's trigger files name (`served`); any other host is another
 * machine's, whose own drain admits it.
 */
export function admittedByText(hostId: string, served: ReadonlySet<string>): string {
  return served.has(hostId)
    ? `the next run end on this install or the wake watcher's next pass (archon workflow wake --watch) admits it; archon trigger drain --host ${hostId} admits it now`
    : `no trigger file on this install names host ${hostId}; that host's own drain admits it (archon trigger drain --host ${hostId} where it runs)`;
}

/**
 * One start waiting for capacity. The request id prints in full: it is what
 * `archon trigger inspect` and `archon trigger withdraw` take. Under the install hold
 * nothing is admitted, which the section already says, so no admitter is named.
 */
function queuedLines(start: ItemQueuedStart, served: ReadonlySet<string>, held: boolean): string[] {
  const waits =
    start.ahead === 0
      ? `next for a free slot on host ${start.hostId}`
      : `${String(start.ahead)} ahead on host ${start.hostId}`;
  const lines = [
    `  ${start.requestId}  ${start.workflow ?? '(launch unreadable)'}  on ${start.resource}, ${waits}, queued ${minute(start.queuedAt)}`,
  ];
  if (start.heldBehind) lines.push(...heldBehindLines('waits behind', start.heldBehind));
  if (!held) lines.push(`            ${admittedByText(start.hostId, served)}`);
  return lines;
}

/** A start not yet prepared: kept by the install hold, or waiting for its host's drain. */
function heldLines(start: ItemHeldStart, served: ReadonlySet<string>, held: boolean): string[] {
  const head = `  receipt ${start.receiptId}  ${start.workflow ?? '(binding unreadable)'}  binding ${start.bindingId}, received ${minute(start.receivedAt)}`;
  if (held) return [`${head}, waits for the install hold`];
  if (start.hostId === null)
    return [`${head}, names no host; archon trigger inspect ${start.receiptId} shows it`];
  return [
    `${head}, waits to be prepared on host ${start.hostId}`,
    `            ${admittedByText(start.hostId, served)}`,
  ];
}

/**
 * The item's starts with no run: those waiting to start, unprepared ones first, then any
 * that were refused.
 */
function startSectionLines(read: ItemRead, served: ReadonlySet<string>): string[] {
  const lines = ['', 'Waiting to start:'];
  if (read.hold)
    lines.push(
      `  New runs are held on this install (${describeInstallHold(read.hold)}); nothing starts until archon hold lift.`
    );
  const held = read.hold !== null;
  for (const start of read.held) lines.push(...heldLines(start, served, held));
  if (read.queued.length === 0 && read.held.length === 0) lines.push('  none');
  for (const start of read.queued) lines.push(...queuedLines(start, served, held));
  if (read.skipped.length > 0) {
    lines.push('', 'Refused starts:');
    for (const start of read.skipped) lines.push(...skippedLines(start));
  }
  return lines;
}

/**
 * One link, read from the item it is printed under: `→` points at what this item depends
 * on, is part of or duplicates; `←` names an item that points at this one.
 */
function linkLine(link: ItemReadLink, projectKey: string): string {
  const other =
    link.other.projectKey === projectKey
      ? link.other.key
      : `${link.other.projectKey}/${link.other.key}`;
  const relation =
    link.direction === 'outgoing'
      ? `this item ${link.kind} → ${other}`
      : `← ${other} ${link.kind} this item`;
  const ended =
    link.ended === null
      ? ''
      : ` (ended ${minute(link.ended.at)}${answererText(link.ended.by)}, via ${link.ended.via})`;
  return `  ${link.id}  ${relation}${ended}`;
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

/** What the item waits for outside Archon, each open wait with when it falls due. */
function waitLines(read: ItemRead): string[] {
  if (read.waits.length === 0) return ['  none'];
  return read.waits.map(
    wait =>
      `  '${wait.event}' about ${wait.about}, since ${minute(wait.waitingSince)}, ${wait.overdue ? 'overdue since' : 'due'} ${minute(wait.deadline)} (left by ${wait.workflow} run ${wait.runId.slice(0, 8)})`
  );
}

/** The facts under the item's name: its merge and the branch it lands on. */
function itemFactLines(read: ItemRead): string[] {
  const lines: string[] = [];
  if (read.merged !== null) lines.push(`Merged ${minute(read.merged.at)}: ${read.merged.change}`);
  if (read.degraded.some(report => report.reason === 'merge_unreadable'))
    lines.push('The merge recorded on this item could not be read.');
  if (read.landing !== null)
    lines.push(`Lands on: ${read.landing.branch} (${landingSourceText(read.landing)})`);
  for (const report of read.degraded)
    if (report.reason === 'landing_unresolved') lines.push(`Lands on: unknown. ${report.message}`);
  return lines;
}

/**
 * The item read as lines a terminal prints, each section saying `none` when empty.
 * `served` are the hosts this install drains (`installHosts`), which decide what a waiting
 * start is told admits it.
 */
export function itemReadLines(read: ItemRead, served: ReadonlySet<string>): string[] {
  const lines = [`Item ${read.item.key} (${read.item.projectKey})`, ...itemFactLines(read)];
  lines.push('', 'Runs:');
  if (read.runs.length === 0) lines.push('  none');
  for (const run of read.runs) lines.push(...runLines(run));
  lines.push(...startSectionLines(read, served));
  lines.push('', 'Links:');
  // Active links first; an ended one stays readable below them.
  const active = read.links.filter(link => link.ended === null);
  const ended = read.links.filter(link => link.ended !== null);
  if (read.links.length === 0) lines.push('  none');
  for (const link of [...active, ...ended]) lines.push(linkLine(link, read.item.projectKey));
  const links = read.degraded.flatMap(report => ('linkId' in report ? [report.linkId] : []));
  if (links.length > 0)
    lines.push(
      `  ${String(links.length)} link(s) of this item could not be read: ${links.join(', ')}`
    );
  lines.push('', 'Waiting for:', ...waitLines(read));
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
