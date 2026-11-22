/**
 * The merge stage's gate, its one merge, and its record: the judge decides, this script
 * acts and says how the run left the item.
 *
 * After the judge it reads the pull request again, because only the forge says what
 * merged: one that reads back merged is recorded merged whatever was declared, and a
 * closed one is parked. A declared `merge` goes through the gate (`gateRefusals`), read
 * fresh, and merges pinned to the declared head; a refusal, or a merge the forge cannot
 * verify, leaves the item waiting with the reasons. A merge moves the default branch, so
 * the forge may not have computed whether the next pull request merges yet: that read is
 * repeated a few times before the gate refuses it.
 *
 * The decision is then written on the work item, with a maintainer's approval when the
 * run was started by one, and the node returns what the engine acts on:
 *
 * - `outcome`, which the pack's run-ended bindings route: `returned` starts the item's
 *   next build round, and a merge starts a discoveries drain and, as `merged_retriage`,
 *   intake's re-triage of an issue the merge left open.
 * - `waits`, the forge events an item that did not merge waits for (`eventWaits`).
 * - `asks`, the judge's question as it wrote it. The run that the answer starts reads
 *   `head` and `brief` from this node's result.
 *
 * A return hands the item to the build queue with its brief. One a maintainer's answer
 * chose first writes the maintainer's words into the issue body as a dated "Current
 * scope" section, so the round reads them as the contract. An ask's options are fixed
 * (`ASK_OPTIONS`); the judge writes only the question and its recommendation.
 *
 * Bound inputs: INPUTS_START, the facts node's output; INPUTS_JUDGED, the judge's, "null"
 * when it was skipped; the workflow's INPUTS_MERGE_METHOD and INPUTS_RETRIAGE_MERGED and
 * the pack setting INPUTS_PROTECTED_PATHS.
 */

import { emit, input, ItemWriteError, recordMerge, refuse, runId as workflowRunId } from 'archon:script';
import { withBuild } from '../../.shared/build.ts';
import type { QualifiedPr } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { appendSection, viewIssue } from '../../.shared/issue.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import {
  ASK_OPTIONS,
  type BaseFacts,
  type EventWait,
  eventWaits,
  gateRefusals,
  listSetting,
  MERGE_METHODS,
  type MergeAnswer,
  type MergeDecisionEntry,
  type MergeMethod,
  type MergeStart,
  type MergeStatus,
  mergeAtHead,
  type PrFacts,
  protectedChanges,
  readBase,
  readPr,
  withMerge,
} from '../../.shared/merge.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';
import { announce, rulingHeading } from '../../.shared/queue.ts';
import { enqueue, updateWorkItem } from '../../.shared/workitem.ts';

type Judged = NodeOutput<'archon-merge-queue', 'judge'>['decision'];

/** How the run leaves the item. */
interface Settled {
  readonly status: MergeStatus;
  /** The decision as the record names it. */
  readonly decision: string;
  readonly reason: string;
  readonly head: string | null;
  readonly reran: boolean;
  /** The brief the item's next build round starts from, on a return. */
  readonly brief: string;
  readonly merge_commit: string | null;
  /** The pull request and the default branch as last read, for what a waiting item waits on. */
  readonly facts: PrFacts | null;
  readonly base: BaseFacts | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UNKNOWN_READS = 4;
const UNKNOWN_PAUSE_MS = 5000;

/**
 * The pull request's facts, read again while the forge has not computed whether it merges.
 * The sleep is on purpose: the forge sends no event for "mergeability computed", and
 * GitHub computes it lazily right after a push to either branch. Without this short
 * re-read the item would wait for the 30 minute backstop.
 */
function readComputed(pr: QualifiedPr, maintainers: ReadonlySet<string>): PrFacts {
  let facts = readPr(pr, maintainers);
  for (let reads = 1; reads < UNKNOWN_READS && facts.behind > 0 && facts.mergeable === 'unknown'; reads++) {
    Bun.sleepSync(UNKNOWN_PAUSE_MS);
    facts = readPr(pr, maintainers);
  }
  return facts;
}

/** Gate the pull request at `head` and merge it when nothing refuses: the landed commit, or why it did not merge. */
function gateAndMerge(start: MergeStart, pr: QualifiedPr, head: string, facts: PrFacts, base: BaseFacts, method: MergeMethod): string | string[] {
  try {
    const refusals = gateRefusals(facts, head, base, start.ci === 'forge' ? { mode: 'forge' } : { mode: 'none', validation: start.validation }, {
      manual: start.lane === 'manual',
      protected: protectedChanges(pr, listSetting(input('protected_paths')), head),
      approved: start.record?.approval?.head ?? null,
    });
    return refusals.length > 0 ? refusals : mergeAtHead(pr, head, method);
  } catch (error) {
    return [`the gate or the merge did not complete: ${message(error)}`];
  }
}

/** Act on the judge's decision, against the pull request as the forge reports it now. */
function decide(start: MergeStart, judged: Judged | null, method: MergeMethod): Settled {
  const { pr } = start;
  if (judged === null || pr === null) throw new Error('the judge path reached settle with no decision');
  const made = { decision: `${judged.action} (${judged.class})`, reason: judged.reason, head: judged.head, reran: judged.reran, brief: '', merge_commit: null };
  let facts = readComputed(pr, readMaintainers(pr.repo));
  const base = readBase(pr.repo);
  let landed: string | string[] = [];
  if (facts.state === 'open' && judged.action === 'merge') {
    landed = gateAndMerge(start, pr, judged.head, facts, base, method);
    if (typeof landed === 'string') facts = { ...facts, state: 'merged', merge_commit: landed, head_revision: judged.head };
  }
  const read = { facts, base };
  if (facts.state === 'merged') {
    const reason = `${judged.reason} (merged ${facts.merge_commit ?? ''} at ${facts.head_revision})`;
    return { ...made, ...read, status: 'merged', decision: `merged (${judged.class})`, reason, head: facts.head_revision, merge_commit: facts.merge_commit };
  }
  if (facts.state === 'closed') return { ...made, ...read, status: 'parked', reason: `${facts.url} was closed while it was judged` };
  if (typeof landed !== 'string' && judged.action === 'merge') {
    return { ...made, ...read, status: 'waiting', decision: `merge refused (${judged.class})`, reason: `not merged: ${landed.join('; ')}` };
  }
  if (judged.action === 'return') return { ...made, ...read, status: 'returned', brief: judged.brief };
  return { ...made, ...read, status: judged.action === 'ask' ? 'asking' : 'waiting' };
}

/** How a run with nothing to judge leaves the item. */
function settledWithout(start: MergeStart): Settled {
  const { facts, base, answer } = start;
  const none = { reran: false, brief: '', merge_commit: null, facts, base };
  if (start.path === 'wait') {
    return { ...none, status: 'waiting', decision: 'wait', reason: 'a check completed, and what it waits for is still not there', head: facts?.head_revision ?? null };
  }
  if (start.settled === null) throw new Error('the settle path reached settle with nothing settled');
  const { status, reason } = start.settled;
  const head = facts?.head_revision ?? answer?.head ?? null;
  return { ...none, status, decision: answer === null ? status : `answered: ${answer.effect}`, reason, head, merge_commit: facts?.merge_commit ?? null };
}

/**
 * Write a maintainer's words into the issue body as the ruling, and return the brief a
 * returned round starts from: the brief the asking run wrote, and where the ruling is.
 */
function ruled(item: QualifiedPr, pr: QualifiedPr | null, answer: MergeAnswer, at: string): string {
  const chose = `The maintainer chose "${answer.effect}"`;
  if (answer.text === '') return `${answer.brief}\n\n${chose} and wrote nothing more.`;
  const heading = rulingHeading(at, `the merge stage's question on PR ${String(pr?.number ?? '')}`);
  appendSection(item, heading, `The maintainer's words: ${answer.text}`);
  return `${answer.brief}\n\n${chose}. What to change is the issue body's "${heading}" section, which is part of the contract.`;
}

/**
 * The judge's question as the engine opens it, with the stage's fixed options. A
 * recommendation that names none of them falls back to `park`, and says so.
 */
function ask(asked: NonNullable<Judged['ask']>): Record<string, unknown> {
  const { option, why } = asked.recommendation;
  const known = ASK_OPTIONS.some(candidate => candidate.id === option);
  const recommendation = known ? asked.recommendation : { option: 'park', why: `The judge recommended "${option}", which is not an option, so this falls back to park. ${why}` };
  return { question: asked.question, context: asked.context, options: ASK_OPTIONS, recommendation, artifacts: [] };
}

/** Say what the stage did with the pull request, once its work item holds it. */
function announceSettled(start: MergeStart, settled: Settled): void {
  const issue = String(start.item.number);
  const pr = String(start.pr?.number ?? '');
  const labels = { stage: 'merge', kind: settled.status, item: issue, pr };
  if (settled.status === 'merged') {
    const lane = start.record?.approval?.head === settled.head ? 'manual' : 'auto';
    announce(`PR ${pr} merged at ${String(settled.head)} (${lane === 'manual' ? 'approved' : 'auto'})`, { ...labels, lane });
  }
  if (settled.status === 'returned') announce(`PR ${pr} returned to build; ${settled.reason}`, labels);
  if (settled.status === 'parked') announce(`Issue ${issue}: parked; ${settled.reason}`, labels);
}

/**
 * Record intake's re-triage request for an issue its merged pull request left open
 * (`Refs #N`), when `retriage_merged` is on. The run then ends `merged_retriage`, which
 * starts intake.
 */
function retriageOpen(item: QualifiedPr, runId: string, at: string): boolean {
  if (input('retriage_merged').trim() !== 'true' || viewIssue(item).state !== 'open') return false;
  enqueue(item, { at, run_id: runId, action: 'retriage', label: null, actor: null, body_digest: null });
  return true;
}

/**
 * Write the decision on the work item: the merge record, an approval the answer gave, and
 * on a return the build queue's next brief. A run a check woke that waits again decided
 * nothing, and writes nothing: one entry per completed check would push the decisions
 * the judge reads, such as a rerun at this head, out of the record.
 */
function record(start: MergeStart, settled: Settled, brief: string, runId: string, at: string): void {
  if (start.path === 'wait') return;
  const { answer } = start;
  const entry: MergeDecisionEntry = {
    at,
    run_id: runId,
    decision: settled.decision,
    reason: settled.reason,
    links: start.url === '' ? [] : [start.url],
    head: settled.head,
    reran: settled.reran,
    ...(answer === null ? {} : { answer: { choice: answer.effect, text: answer.text, at: answer.at } }),
  };
  const approval = answer?.effect === 'merge' ? { approval: { head: answer.head, at: answer.at } } : {};
  updateWorkItem(start.item, doc => {
    const recorded = withMerge(doc, { at, run_id: runId, entry, status: settled.status, pr: start.pr, ...approval });
    if (settled.status !== 'returned') return recorded;
    return withBuild(recorded, { at, run_id: runId, round: null, entry: { ...entry, decision: 'returned by the merge stage' }, status: 'next', brief });
  });
}

/** Put the merge on the engine item, and say whether the still-open issue asks intake for a re-triage. */
function afterMerge(start: MergeStart, settled: Settled, runId: string, at: string, lines: string[]): 'merged' | 'merged_retriage' {
  // The engine's item metrics read the merge from the item, never from the work item. The
  // run is on the issue's item, so its own item is the one to record on.
  try {
    recordMerge({ change: start.url, at, commit: settled.merge_commit });
  } catch (error) {
    // A refusal wrote nothing; any other failure leaves the write unknown, so it is not
    // retried and not reported as missing.
    lines.push(
      error instanceof ItemWriteError
        ? `its merge is not on the engine item (${error.reason})`
        : `its merge may not be on the engine item: the write could not be confirmed (${message(error)})`
    );
  }
  try {
    return retriageOpen(start.item, runId, at) ? 'merged_retriage' : 'merged';
  } catch (error) {
    lines.push(`its issue was not sent to intake for a re-triage: ${message(error)}`);
    return 'merged';
  }
}

/**
 * What a waiting item waits for. A red default branch is also reported with the judge's
 * diagnosis: once per judgment, so a run a check woke to the same red branch says nothing.
 */
function waitsOf(start: MergeStart, settled: Settled, diagnosis: string | null, lines: string[]): EventWait[] {
  const { facts, base } = settled;
  if (settled.status !== 'waiting' || facts === null || base === null) return [];
  if (base.checks.state === 'red') {
    const pr = String(start.pr?.number ?? '');
    const red = `The default branch ${base.branch} is red at ${base.head} (${base.checks.failing.join(', ')}); nothing merges until it is green.`;
    lines.push([red, diagnosis ?? ''].filter(line => line !== '').join(' '));
    if (diagnosis !== null) announce(`${red} PR ${pr} waits. ${diagnosis}`, { stage: 'merge', kind: 'base-red', item: String(start.item.number), pr });
  }
  return eventWaits(facts, base, start.ci, settled.reran);
}

function main(): void {
  const start = nullableJson(input('start')) as MergeStart;
  const judgment = nullableJson(input('judged')) as NodeOutput<'archon-merge-queue', 'judge'> | null;
  const judged = judgment?.decision ?? null;
  const method = MERGE_METHODS.find(candidate => candidate === input('merge_method').trim());
  if (method === undefined) throw new Error(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  const runId = workflowRunId();
  const at = new Date().toISOString();
  const { item, pr, answer } = start;

  const settled = start.path === 'judge' ? decide(start, judged, method) : settledWithout(start);
  // The ruling is written first, so the returned round's brief can name its section.
  const ruling = answer === null ? '' : ruled(item, pr, answer, at);
  const brief = answer?.effect === 'return' ? ruling : settled.brief;
  record(start, settled, brief, runId, at);

  const asking = settled.status === 'asking';
  const lines = [`${pr === null ? `Issue ${String(item.number)}` : `PR ${String(pr.number)}`}: ${settled.decision}; ${settled.reason}`];
  const outcome = settled.status === 'merged' ? afterMerge(start, settled, runId, at, lines) : asking ? 'asked' : settled.status;
  announceSettled(start, settled);
  const waits = waitsOf(start, settled, judgment?.base ?? null, lines);
  emit({
    outcome,
    summary: lines.join('\n'),
    number: item.number,
    head: settled.head ?? '',
    brief: asking ? (judged?.brief ?? '') : brief,
    asks: asking && judged?.ask != null ? [ask(judged.ask)] : [],
    waits,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue settle: ${message(error)}`);
}
