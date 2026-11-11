/**
 * Read back what the sweep did and record one decision per claimed item.
 *
 * The forge, not the sweep, says which pull requests merged: one that reads back merged
 * is recorded merged at the head the forge merged, whatever the sweep declared, and one
 * that does not is never recorded merged. A sweep that claims a merge the forge does not
 * show fails the record, but only after every decision is written: that pull request is
 * recorded as waiting for the next sweep, or parked if it was closed. A claimed pull
 * request the sweep left undecided waits for the next sweep. A `return` hands the item
 * back to the build queue with its brief and starts its next round through the
 * build-queue binding. A run holds one wait, so it raises one attention item: the
 * sweep's item for a red default branch first, because it holds every merge, otherwise
 * the first pull request the sweep asked about, in its order. That item keeps its claim
 * while the run waits; every other claim is released, and an ask that was not raised
 * waits for the next sweep, which decides it again. A `wait` the sweep declared stores
 * the facts it rests on (`waitedOn`), and so does an ask held back by a red default
 * branch's question, so the next sweep hands neither to the agent while they read the
 * same.
 *
 * A pull request that cannot be read back waits for the next sweep, and a work item
 * that cannot be written is reported and left for the next sweep; neither stops the
 * rest of the batch from being recorded. If facts could not read the default branch
 * or the maintainer refresh fails, record settlements without further forge reads,
 * leaving open companions untouched, then fail with the original diagnostic.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEMS, INPUTS_SETTLED, INPUTS_BASE and INPUTS_BASE_ERROR
 * from facts; INPUTS_SWEEP,
 * the sweep's whole output, "null" when it was skipped; the workflow's
 * INPUTS_BUILD_QUEUE_BINDING.
 */

import { nextRound, withBuild } from '../../.shared/build.ts';
import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { type QualifiedPr } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';
import {
  MERGE_PATHS,
  type MergeAsked,
  type MergeAttention,
  type MergeDecisionEntry,
  type MergeRecord,
  type MergeSettled,
  type MergeStatus,
  otherEffect,
  type PrFacts,
  readBase,
  readPr,
  type SweepAction,
  waitedOn,
  withMerge,
} from '../../.shared/merge.ts';
import { askFields, attentionWait } from '../../.shared/queue.ts';

import { idleSummary, stuckItems } from '../../.shared/stuck.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { updateClaimed, type WorkItem } from '../../.shared/workitem.ts';

interface Item {
  readonly item: QualifiedPr | null;
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly facts: PrFacts | null;
  readonly record: MergeRecord | null;
}

/** The sweep's whole output, and one of its decisions, as its output schema admits them. */
type Sweep = NodeOutput<'archon-merge-queue', 'sweep'>;
type Decision = Sweep['decisions'][number];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The decisions record acts on: one per claimed pull request, in the sweep's order. A
 * decision about a pull request this run did not claim is refused with a note, because
 * its work item belongs to another run, and every other decision is still recorded; a
 * claimed one the sweep left out waits for the next sweep. The sweep's output schema
 * already holds each action to what it can act on.
 */
function decide(items: readonly Item[], sweep: Sweep | null): Decision[] {
  if (sweep === null) return [];
  const wanted = new Map(items.map(item => [item.pr.number, item]));
  const strays = sweep.decisions.filter(decision => !wanted.has(decision.number)).map(decision => decision.number);
  if (strays.length > 0) {
    console.error(`merge-queue record: the sweep decided PR ${strays.join(', ')}, which this run did not claim; not recorded`);
  }
  const decided = new Map<number, Decision>();
  for (const decision of sweep.decisions) {
    if (wanted.has(decision.number) && !decided.has(decision.number)) decided.set(decision.number, decision);
  }
  for (const item of items) {
    if (decided.has(item.pr.number)) continue;
    decided.set(item.pr.number, {
      number: item.pr.number,
      action: 'wait',
      class: 'unclear',
      head: item.facts?.head_revision ?? '',
      reran: false,
      reason: 'the sweep left it undecided; the next sweep decides it',
      brief: '',
      attention: null,
    });
  }
  return [...decided.values()];
}

/** The default branch as facts read it. */
type Base = ReturnType<typeof readBase>;

/** A gate that could not run merged nothing and judged nothing; a `wait` would hide that. */
function gateFailure(sweep: Sweep | null): string[] {
  const error = sweep?.gate_error.trim() ?? '';
  return error === '' ? [] : [`the merge gate could not run, so nothing was gated or merged: ${error}`];
}

/** A red default branch the sweep did not raise would hold every merge in silence. */
function unraisedRedBase(sweep: Sweep | null, base: Base | null): string | null {
  if (sweep === null || base?.checks.state !== 'red' || sweep.base.attention !== null) return null;
  return `the default branch ${base.branch} is red at ${base.head} (${base.checks.failing.join(', ')}), and the sweep did not raise it`;
}

interface Outcome {
  readonly status: MergeStatus;
  readonly reason: string;
  readonly head: string;
  /** Set when the sweep claimed a merge the forge does not show. */
  readonly contradiction: string | null;
}

/** The status, reason and head the forge's read-back supports for one decision. */
function settle(decision: Decision, after: PrFacts): Outcome {
  if (after.state === 'merged') {
    return {
      status: 'merged',
      reason: `${decision.reason} (merged ${after.merge_commit ?? ''} at ${after.head_revision})`,
      head: after.head_revision,
      contradiction: null,
    };
  }
  const head = decision.head;
  const claimed = `the sweep says it merged ${after.url}, but it reads back ${after.state}`;
  if (after.state === 'closed') {
    const contradiction = decision.action === 'merged' ? claimed : null;
    return { status: 'parked', reason: `${after.url} was closed during the sweep`, head, contradiction };
  }
  if (decision.action === 'merged') return { status: 'waiting', reason: claimed, head, contradiction: claimed };
  const status: Record<Exclude<SweepAction, 'merged'>, MergeStatus> = {
    return: 'returned',
    ask: 'waiting',
    wait: 'waiting',
  };
  return { status: status[decision.action], reason: decision.reason, head, contradiction: null };
}

/**
 * Read one pull request back. One that cannot be read waits for the next sweep, whose
 * facts settle it, a merge the gate made included: only the forge says it merged.
 */
function readBack(decision: Decision, item: Item, maintainers: ReadonlySet<string>): Outcome {
  let after: PrFacts;
  try {
    after = readPr(item.pr, maintainers);
  } catch (error) {
    return { status: 'waiting', reason: `${item.url} could not be read back: ${message(error)}`, head: decision.head, contradiction: null };
  }
  return settle(decision, after);
}

/** What one record run writes with, and the lines it reports. */
interface Writes {
  readonly at: string;
  readonly runId: string;
  readonly lines: string[];
  /** Work items that could not be written, for a failure that would otherwise hide them. */
  readonly failed: string[];
}

/** Change one claimed work item; one that cannot be written is reported and left for the next sweep. */
function write(writes: Writes, subject: QualifiedPr, name: string, label: string, change: (doc: WorkItem) => WorkItem): boolean {
  try {
    updateClaimed(subject, writes.runId, change);
    writes.lines.push(`${name}: ${label}`);
    return true;
  } catch (error) {
    const failure = `${name}: not recorded, the next sweep decides it again (${message(error)})`;
    console.error(`merge-queue record: ${failure}`);
    writes.lines.push(failure);
    writes.failed.push(failure);
    return false;
  }
}

function labelOf(decision: Decision, outcome: Outcome, raised: boolean): string {
  if (raised) return 'ask';
  if (outcome.status === 'merged') return 'merged';
  if (decision.action === 'ask') return 'ask (not raised this run)';
  return outcome.contradiction === null ? decision.action : 'claimed merged, not merged';
}

/**
 * Record one pull request's decision; false when its work item could not be written.
 * `against` is the default branch the item's wait is recorded against; null records
 * none, so the next sweep decides the item again.
 */
function recordPr(writes: Writes, item: Item, outcome: Outcome & { readonly decision: Decision }, raised: boolean, against: Base | null): boolean {
  const { at, runId } = writes;
  const { decision, status, reason, head } = outcome;
  const label = labelOf(decision, outcome, raised);
  const decided = `${label} (${decision.class})`;
  const links = [item.url, ...(decision.attention?.links ?? [])];
  const waited =
    status === 'waiting' && against !== null && item.facts !== null
      ? { waited_on: waitedOn(item.facts, against) }
      : {};
  const entry: MergeDecisionEntry = { at, run_id: runId, decision: decided, reason, links, head, reran: decision.reran, ...waited };
  if (item.item === null) {
    writes.lines.push(`PR ${String(decision.number)}: ${label}, with no work item to record it on`);
    return false;
  }
  const name = `PR ${String(decision.number)}`;
  const written = write(writes, item.item, name, label, doc => {
    const recorded = withMerge(doc, { at, run_id: runId, entry, status: raised ? 'asking' : status, pr: item.pr, release: !raised });
    if (status !== 'returned') return recorded;
    const returned = { ...entry, decision: 'returned by the merge queue' };
    return withBuild(recorded, { at, run_id: runId, round: null, entry: returned, status: 'next', brief: decision.brief, release: true });
  });
  // The claim is released, so the round the fire starts can claim the item.
  if (written && status === 'returned') writes.lines.push(`${name}: ${nextRound(item.item, runId)}`);
  return written;
}

/**
 * The default branch a decision's wait is recorded against, or null. Only a decision the
 * sweep itself made, in a record that holds, is one the next sweep may skip: a `wait`,
 * or an ask held back because the red default branch's question took the run's wait.
 */
function waitBase(sweep: Sweep | null, base: Base | null, asked: MergeAsked | null, holds: boolean): (decision: Decision) => Base | null {
  const declared = new Set(holds ? sweep?.decisions.map(decision => decision.number) : []);
  const baseAsked = asked?.by === 'base';
  return decision =>
    declared.has(decision.number) && (decision.action === 'wait' || (decision.action === 'ask' && baseAsked)) ? base : null;
}

function recordSettled(writes: Writes, settled: readonly MergeSettled[]): void {
  for (const done of settled) {
    const entry = { at: writes.at, run_id: writes.runId, decision: done.decision, reason: done.reason, links: [], head: null, reran: false };
    write(writes, done.item, `Issue ${String(done.item.number)}`, done.status, doc =>
      withMerge(doc, { at: writes.at, run_id: writes.runId, entry, status: done.status, pr: done.pr, release: true })
    );
  }
}

function recordBaseFailure(writes: Writes, settled: readonly MergeSettled[], baseError: string): never {
  recordSettled(writes, settled);
  throw new Error([baseError, ...writes.failed, 'every other decision is recorded'].join('; '));
}

function main(): void {
  const path = MERGE_PATHS.find(candidate => candidate === input('path').trim());
  if (path === undefined) throw new Error(`path must be one of ${MERGE_PATHS.join(', ')}`);
  const items = (nullableJson(input('items')) ?? []) as Item[];
  const settled = (nullableJson(input('settled')) ?? []) as MergeSettled[];
  const baseError = input('base_error');
  const runId = workflowRunId();
  const writes: Writes = { at: new Date().toISOString(), runId, lines: [], failed: [] };
  if (baseError !== '') recordBaseFailure(writes, settled, baseError);
  if (path === 'idle') {
    emit({
      merged: [],
      summary: idleSummary('No pull request waits for the merge queue.', stuckItems(workflowRunId())),
      attention: '',
      options: [],
      recommendation: null,
      class: '',
      asked: null,
    });
    return;
  }
  const sweep = nullableJson(input('sweep')) as Sweep | null;
  if (path === 'sweep' && sweep === null) throw new Error('the sweep path reached record with no sweep');
  const decisions = decide(items, sweep);
  const base = nullableJson(input('base')) as Base | null;
  const itemOf = (number: number): Item => items.find(item => item.pr.number === number) as Item;

  const baseAttention = sweep?.base.attention ?? null;
  const firstAsk = decisions.find(decision => decision.attention !== null);
  let asked: MergeAsked | null =
    baseAttention !== null
      ? { by: 'base', attention: baseAttention }
      : firstAsk === undefined
        ? null
        : {
            by: 'pr',
            item: itemOf(firstAsk.number).item as QualifiedPr,
            pr: itemOf(firstAsk.number).pr,
            head: firstAsk.head,
            brief: firstAsk.brief,
            attention: firstAsk.attention as MergeAttention,
          };
  const waitOf = (raised: MergeAsked | null) =>
    raised === null
      ? null
      : raised.by === 'base'
        ? attentionWait<string>('Merge queue: the default branch is red', raised.attention)
        : attentionWait<string>(
            `Merge queue, PR ${String(raised.pr.number)}: merge decision`,
            raised.attention,
            `Your text is written into the issue body as the ruling. ${otherEffect(raised.brief) === 'return' ? 'The item returns to the build queue, and the next round works from it.' : 'Queue work stops until the build queue readies the item again; no build round starts.'}`
          );

  // Settlements are independent of the policy refresh and the sweep's decisions.
  recordSettled(writes, settled);
  const maintainers = items.length > 0 ? readMaintainers(items[0]?.pr.repo as QualifiedPr['repo']) : new Set<string>();

  const outcomes = decisions.map(decision => ({ decision, ...readBack(decision, itemOf(decision.number), maintainers) }));
  const contradictions = [
    ...gateFailure(sweep),
    ...outcomes.flatMap(outcome => (outcome.contradiction === null ? [] : [outcome.contradiction])),
  ];
  const silentRed = unraisedRedBase(sweep, base);
  if (silentRed !== null) contradictions.push(silentRed);
  // A failed record runs no ask node, so it raises nothing: a pull request's ask waits for
  // the next sweep, and a red default branch is named in the failure instead.
  if (asked?.by === 'base' && contradictions.length > 0) {
    contradictions.push(`the default branch is red and was not raised (${sweep?.base.summary ?? ''})`);
  }
  // The asked pull request was merged or closed under the question: there is nothing to ask.
  const askedPr = asked?.by === 'pr' ? asked.pr.number : null;
  if (contradictions.length > 0 || outcomes.some(({ decision, status }) => decision.number === askedPr && status !== 'waiting')) {
    asked = null;
  }

  const against = waitBase(sweep, base, asked, contradictions.length === 0);
  for (const outcome of outcomes) {
    const raised = asked?.by === 'pr' && asked.pr.number === outcome.decision.number;
    if (!recordPr(writes, itemOf(outcome.decision.number), outcome, raised, against(outcome.decision)) && raised) asked = null;
  }
  if (contradictions.length > 0) {
    throw new Error([...contradictions, ...writes.failed, 'every other decision is recorded'].join('; '));
  }

  emit({
    merged: outcomes.flatMap(({ decision, status }) => (status === 'merged' ? [decision.number] : [])),
    summary: [sweep?.summary ?? '', ...writes.lines].filter(line => line !== '').join('\n'),
    ...askFields(waitOf(asked)),
    class: asked?.by ?? '',
    asked,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue record: ${message(error)}`);
}
