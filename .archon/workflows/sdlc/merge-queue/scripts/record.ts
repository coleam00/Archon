/**
 * Read back what the sweep did and record one decision per claimed item.
 *
 * The forge, not the sweep, says which pull requests merged: one that reads back merged
 * is recorded merged at the head the forge merged, whatever the sweep declared, and one
 * that does not is never recorded merged. A sweep that claims a merge the forge does not
 * show fails the record, but only after every decision is written: that pull request is
 * recorded as waiting for the next sweep, or parked if it was closed. A claimed pull
 * request the sweep left undecided waits for the next sweep. A `return` hands the item
 * back to the build queue with its brief. A run raises at most one attention item: a red
 * default branch first, because it holds every merge, otherwise the first pull request
 * the sweep asked about, in its order. That item keeps its claim while the run waits;
 * every other claim is released, and an ask that was not raised waits for the next sweep,
 * which decides it again.
 *
 * A pull request that cannot be read back waits for the next sweep, and a work item
 * that cannot be written is reported and left for the next sweep; neither stops the
 * rest of the batch from being recorded.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEMS and INPUTS_SETTLED from facts; INPUTS_SWEEP,
 * the sweep's whole output, "null" when it was skipped.
 */

import { withBuild } from '../../.shared/build.ts';
import type { QualifiedPr } from '../../.shared/forge.ts';
import { emit, note, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import {
  type DevAttention,
  type DevState,
  MERGE_PATHS,
  type MergeAsked,
  type MergeAttention,
  type MergeDecisionEntry,
  type MergeRecord,
  type MergeSettled,
  type MergeStatus,
  type PolicyClass,
  type PrFacts,
  type Rerun,
  readPr,
  type SweepAction,
  withMerge,
} from '../../.shared/merge.ts';
import { attentionOptions, renderAttention, withOther } from '../../.shared/queue.ts';
import { readMaintainers, updateClaimed, type WorkItem } from '../../.shared/workitem.ts';

interface Item {
  readonly item: QualifiedPr | null;
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly facts: PrFacts | null;
  readonly record: MergeRecord | null;
}

interface Decision {
  readonly number: number;
  readonly action: SweepAction;
  readonly class: PolicyClass;
  readonly head: string;
  readonly synced: boolean;
  readonly reran: boolean;
  readonly reason: string;
  readonly brief: string;
  readonly attention: MergeAttention | null;
}

interface Sweep {
  readonly decisions: readonly Decision[];
  readonly review_url: string;
  readonly review_prior: string;
  readonly dev: {
    readonly state: DevState;
    readonly rerun: Rerun;
    readonly summary: string;
    readonly attention: DevAttention | null;
  };
  readonly summary: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The decisions record acts on: one per claimed pull request, in the sweep's order. A
 * decision about a pull request this run did not claim refuses, because its work item
 * belongs to another run; a claimed one the sweep left out waits for the next sweep.
 */
function decide(items: readonly Item[], sweep: Sweep): Decision[] {
  const wanted = new Map(items.map(item => [item.pr.number, item]));
  const strays = sweep.decisions.filter(decision => !wanted.has(decision.number)).map(decision => decision.number);
  if (strays.length > 0) throw new Error(`the sweep decided PR ${strays.join(', ')}, which this run did not claim`);
  const decided = new Map<number, Decision>();
  for (const decision of sweep.decisions) {
    if (decided.has(decision.number)) continue;
    // An ask the sweep wrote no item for has nothing to raise; it waits like any other undecided one.
    const asks = decision.action === 'ask' && decision.attention !== null;
    decided.set(decision.number, asks ? decision : { ...decision, action: decision.action === 'ask' ? 'wait' : decision.action, attention: null });
  }
  for (const item of items) {
    if (decided.has(item.pr.number)) continue;
    decided.set(item.pr.number, {
      number: item.pr.number,
      action: 'wait',
      class: 'unclear',
      head: item.facts?.head_revision ?? '',
      synced: false,
      reran: false,
      reason: 'the sweep left it undecided; the next sweep decides it',
      brief: '',
      attention: null,
    });
  }
  return [...decided.values()];
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
    review: 'waiting',
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
    after = readPr(item.pr, maintainers).facts;
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
    note(`merge-queue record: ${failure}`);
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

/** Record one pull request's decision; false when its work item could not be written. */
function recordPr(writes: Writes, item: Item, outcome: Outcome & { readonly decision: Decision }, raised: boolean): boolean {
  const { at, runId } = writes;
  const { decision, status, reason, head } = outcome;
  const label = labelOf(decision, outcome, raised);
  const decided = `${label} (${[decision.class, ...(decision.synced ? ['synced'] : [])].join(', ')})`;
  const links = [item.url, ...(decision.attention?.links ?? [])];
  const entry: MergeDecisionEntry = { at, run_id: runId, decision: decided, reason, links, head, reran: decision.reran };
  if (item.item === null) {
    writes.lines.push(`PR ${String(decision.number)}: ${label}, with no work item to record it on`);
    return false;
  }
  return write(writes, item.item, `PR ${String(decision.number)}`, label, doc => {
    const recorded = withMerge(doc, { at, run_id: runId, entry, status: raised ? 'asking' : status, pr: item.pr, release: !raised });
    if (status !== 'returned') return recorded;
    const returned = { ...entry, decision: 'returned by the merge queue' };
    return withBuild(recorded, { at, run_id: runId, round: null, entry: returned, status: 'next', brief: decision.brief, release: true });
  });
}

function main(): void {
  const path = MERGE_PATHS.find(candidate => candidate === trimmed(process.env.INPUTS_PATH));
  if (path === undefined) throw new Error(`path must be one of ${MERGE_PATHS.join(', ')}`);
  const items = (nullableJson(process.env.INPUTS_ITEMS) ?? []) as Item[];
  const settled = (nullableJson(process.env.INPUTS_SETTLED) ?? []) as MergeSettled[];
  const sweep = nullableJson(process.env.INPUTS_SWEEP) as Sweep | null;
  if (path === 'idle') {
    emit({
      merged: [],
      summary: 'No pull request waits for the merge queue.',
      attention: '',
      options: [],
      class: '',
      asked: null,
    });
    return;
  }
  if (path === 'sweep' && sweep === null) throw new Error('the sweep path reached record with no sweep');
  const decisions = sweep === null ? [] : decide(items, sweep);
  const itemOf = (number: number): Item => items.find(item => item.pr.number === number) as Item;

  // A red default branch holds every merge whether or not the sweep wrote an item for it.
  const devAttention = sweep?.dev.state === 'red' ? sweep.dev.attention : null;
  const firstAsk = decisions.find(decision => decision.attention !== null);
  let asked: MergeAsked | null =
    devAttention !== null
      ? { by: 'dev', attention: devAttention }
      : firstAsk === undefined
        ? null
        : {
            by: 'pr',
            item: itemOf(firstAsk.number).item as QualifiedPr,
            pr: itemOf(firstAsk.number).pr,
            head: firstAsk.head,
            brief: firstAsk.brief,
            // `other` hands the item back to the build queue with the person's text as the ruling.
            attention: withOther(firstAsk.attention as MergeAttention, 'return'),
          };
  const render = (raised: MergeAsked | null): string =>
    raised === null
      ? ''
      : raised.by === 'dev'
        ? renderAttention('Merge queue: the default branch is red after a batch', raised.attention)
        : renderAttention(`Merge queue, PR ${String(raised.pr.number)}: merge decision`, raised.attention);

  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const writes: Writes = { at: new Date().toISOString(), runId, lines: [], failed: [] };
  const maintainers = items.length > 0 ? readMaintainers(items[0]?.pr.repo as QualifiedPr['repo']) : new Set<string>();

  // Every read and check happens before the first write, so a check that refuses writes nothing.
  const outcomes = decisions.map(decision => ({ decision, ...readBack(decision, itemOf(decision.number), maintainers) }));
  const contradictions = outcomes.flatMap(outcome => (outcome.contradiction === null ? [] : [outcome.contradiction]));
  // A failed record runs no ask node, so it raises nothing: a pull request's ask waits for
  // the next sweep, and a red default branch is named in the failure instead.
  if (asked?.by === 'dev' && contradictions.length > 0) {
    contradictions.push(`the default branch is red after the batch and was not raised (${sweep?.dev.summary ?? ''})`);
  }
  // The asked pull request was merged or closed under the question: there is nothing to ask.
  const askedPr = asked?.by === 'pr' ? asked.pr.number : null;
  if (contradictions.length > 0 || outcomes.some(({ decision, status }) => decision.number === askedPr && status !== 'waiting')) {
    asked = null;
  }

  for (const outcome of outcomes) {
    const raised = asked?.by === 'pr' && asked.pr.number === outcome.decision.number;
    if (!recordPr(writes, itemOf(outcome.decision.number), outcome, raised) && raised) asked = null;
  }
  for (const done of settled) {
    const entry = { at: writes.at, run_id: runId, decision: done.decision, reason: done.reason, links: [], head: null, reran: false };
    write(writes, done.item, `Issue ${String(done.item.number)}`, done.status, doc =>
      withMerge(doc, { at: writes.at, run_id: runId, entry, status: done.status, pr: done.pr, release: true })
    );
  }
  if (contradictions.length > 0) {
    throw new Error([...contradictions, ...writes.failed, 'every other decision is recorded'].join('; '));
  }

  emit({
    merged: outcomes.flatMap(({ decision, status }) => (status === 'merged' ? [decision.number] : [])),
    summary: [sweep?.summary ?? '', ...writes.lines].filter(line => line !== '').join('\n'),
    attention: render(asked),
    options: asked === null ? [] : attentionOptions<string>(asked.attention),
    class: asked?.by ?? '',
    asked,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue record: ${message(error)}`);
}
