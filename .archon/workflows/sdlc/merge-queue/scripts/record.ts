/**
 * Check the sweep's decisions, read back what it did, and record one decision per item.
 *
 * Every claimed pull request gets exactly one decision, and the forge, not the sweep,
 * says which were merged: a pull request reads back merged or it was not. The gate's
 * receipts say which merges this run made: a pull request with one must be declared
 * merged at the receipt's head, and one declared merged must have one, or the record
 * refuses before it writes anything. A run whose gate merged must have checked the
 * default branch after its batch, and one that merged nothing raises nothing about it. A
 * `return` hands the item back to the build queue with its brief. A run raises at most
 * one attention item: a red default branch first, because it holds every merge,
 * otherwise the first pull request the sweep asked about, in its order. That item keeps
 * its claim while the run waits; every other claim is released, and an ask that was not
 * raised waits for the next sweep, which decides it again.
 *
 * A pull request that cannot be read back waits for the next sweep, and a work item
 * that cannot be written is reported and left for the next sweep; neither stops the
 * rest of the batch from being recorded.
 *
 * Eval writes nothing and returns the decisions, with the attention item live would
 * raise, as `evaluation`.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEMS and INPUTS_SETTLED from facts; INPUTS_SWEEP,
 * the sweep's whole output, "null" when it was skipped.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  type Receipt,
  type Rerun,
  readPr,
  receiptsDir,
  type SweepAction,
  withMerge,
} from '../../.shared/merge.ts';
import { attentionOptions, checkAttention, renderAttention } from '../../.shared/queue.ts';
import { type IntakeMode, parseMode, readMaintainers, updateClaimed, type WorkItem } from '../../.shared/workitem.ts';

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

/** Refuse a sweep output the queue cannot act on, before anything is written. */
function check(mode: IntakeMode, items: readonly Item[], sweep: Sweep, receipts: Receipts): void {
  const wanted = new Map(items.map(item => [item.pr.number, item]));
  const seen = new Set<number>();
  for (const decision of sweep.decisions) {
    const name = `PR ${String(decision.number)}`;
    const item = wanted.get(decision.number);
    if (item === undefined) throw new Error(`the sweep decided ${name}, which this run did not claim`);
    if (seen.has(decision.number)) throw new Error(`the sweep decided ${name} twice`);
    seen.add(decision.number);
    if ((decision.action === 'ask') !== (decision.attention !== null)) {
      throw new Error(`${name}: an attention item comes with an ask and only with one`);
    }
    if (decision.attention !== null) checkAttention(decision.attention);
    if (decision.action === 'return' && decision.brief.trim() === '') {
      throw new Error(`${name}: a return has no brief for the build queue`);
    }
    if (mode === 'eval') continue;
    if (item.item === null) throw new Error(`${name} has no work item`);
    const receipt = receipts.get(decision.number) ?? null;
    if (decision.action === 'merged' && receipt?.head !== decision.head) {
      throw new Error(`${name}: the sweep says it merged at ${decision.head}, but the gate wrote no receipt at that head`);
    }
    if (decision.action !== 'merged' && receipt !== null) {
      throw new Error(`${name}: the gate merged it at ${receipt.head}, but the sweep declared ${decision.action}`);
    }
    const reranBefore = item.record?.decisions.some(entry => entry.reran && entry.head === decision.head) ?? false;
    if (decision.reran && reranBefore) {
      throw new Error(`${name}: the queue already re-ran the failed checks at ${decision.head}; red again counts as the change's`);
    }
  }
  const missing = [...wanted.keys()].filter(number => !seen.has(number));
  if (missing.length > 0) throw new Error(`the sweep left PR ${missing.join(', ')} undecided`);
  const strays = [...receipts.keys()].filter(number => !wanted.has(number));
  if (strays.length > 0) throw new Error(`the gate merged PR ${strays.join(', ')}, which this run did not claim`);
  if (sweep.review_url !== '') {
    const reviewed = sweep.decisions.find(decision => items.find(item => item.pr.number === decision.number)?.url === sweep.review_url);
    if (reviewed?.action !== 'review') throw new Error(`the delta review names ${sweep.review_url}, which the sweep did not send to review`);
  }
  if ((sweep.dev.state === 'red') !== (sweep.dev.attention !== null)) {
    throw new Error('an attention item on the default branch comes with a red one and only with one');
  }
  if (sweep.dev.attention !== null) checkAttention(sweep.dev.attention);
  if (sweep.dev.state === 'unchecked' && sweep.dev.rerun !== 'none') {
    throw new Error('the default branch was re-run but never checked');
  }
  if (mode === 'eval') return;
  if (receipts.size > 0 && sweep.dev.state === 'unchecked') {
    throw new Error("the sweep merged but did not check the default branch's CI after its batch");
  }
  if (receipts.size === 0 && sweep.dev.state !== 'unchecked') {
    throw new Error('the sweep merged nothing, so it has no batch to judge the default branch after');
  }
}

/** The gate's receipts for this run, by pull request number. */
type Receipts = ReadonlyMap<number, Receipt>;

function readReceipts(): Receipts {
  const dir = receiptsDir();
  if (!existsSync(dir)) return new Map();
  return new Map(
    readdirSync(dir).map(name => [Number(name.replace(/\.json$/, '')), JSON.parse(readFileSync(join(dir, name), 'utf8')) as Receipt])
  );
}

interface Outcome {
  readonly status: MergeStatus;
  readonly reason: string;
}

/** The status and reason the forge's read-back supports for one decision. */
function settle(decision: Decision, after: PrFacts, receipts: Receipts): Outcome {
  if (after.state === 'merged') {
    if (decision.action === 'merged' && receipts.get(decision.number)?.head !== after.head_revision) {
      throw new Error(`the sweep says it merged ${after.url}, but it merged at ${after.head_revision}, not the head the gate passed`);
    }
    const outside = decision.action === 'merged' ? '' : '; merged outside this run';
    return { status: 'merged', reason: `${decision.reason} (merged ${after.merge_commit ?? ''} at ${after.head_revision}${outside})` };
  }
  if (decision.action === 'merged') {
    throw new Error(`the sweep says it merged ${after.url}, but it reads back ${after.state}`);
  }
  if (after.state === 'closed') return { status: 'parked', reason: `${after.url} was closed during the sweep` };
  const status: Record<Exclude<SweepAction, 'merged'>, MergeStatus> = {
    review: 'waiting',
    return: 'returned',
    ask: 'waiting',
    wait: 'waiting',
  };
  return { status: status[decision.action], reason: decision.reason };
}

/**
 * Read one pull request back. One that cannot be read waits for the next sweep, whose
 * facts settle it, a merge the gate made included: only the forge says it merged.
 */
function readBack(decision: Decision, item: Item, maintainers: ReadonlySet<string>, receipts: Receipts): Outcome {
  let after: PrFacts;
  try {
    after = readPr(item.pr, maintainers).facts;
  } catch (error) {
    return { status: 'waiting', reason: `${item.url} could not be read back: ${message(error)}` };
  }
  return settle(decision, after, receipts);
}

function main(): void {
  const mode = parseMode(text(process.env.INPUTS_MODE));
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
      evaluation: null,
    });
    return;
  }
  if (path === 'sweep' && sweep === null) throw new Error('the sweep path reached record with no sweep');
  const decisions = sweep?.decisions ?? [];
  const receipts = readReceipts();
  if (sweep !== null) check(mode, items, sweep, receipts);
  const itemOf = (number: number): Item => items.find(item => item.pr.number === number) as Item;

  const asks = decisions.filter(decision => decision.attention !== null);
  const devAttention = sweep?.dev.attention ?? null;
  const firstAsk = asks[0];
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
            attention: firstAsk.attention as MergeAttention,
          };
  const render = (raised: MergeAsked | null): string =>
    raised === null
      ? ''
      : raised.by === 'dev'
        ? renderAttention('Merge queue: the default branch is red after a batch', raised.attention)
        : renderAttention(`Merge queue, PR ${String(raised.pr.number)}: merge decision`, raised.attention);

  if (mode === 'eval') {
    emit({
      merged: [],
      summary: sweep?.summary ?? '',
      attention: '',
      options: [],
      class: '',
      asked: null,
      evaluation: {
        decisions,
        dev: sweep?.dev ?? null,
        review_url: sweep?.review_url ?? '',
        asked: asked?.by ?? null,
        attention: render(asked),
      },
    });
    return;
  }

  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const at = new Date().toISOString();
  const maintainers = items.length > 0 ? readMaintainers(items[0]?.pr.repo as QualifiedPr['repo']) : new Set<string>();
  const merged: number[] = [];
  const lines: string[] = [];

  // Every read and check happens before the first write, so a refusal writes nothing.
  const outcomes = decisions.map(decision => ({ decision, ...readBack(decision, itemOf(decision.number), maintainers, receipts) }));
  const write = (subject: QualifiedPr, label: string, change: (doc: WorkItem) => WorkItem): boolean => {
    try {
      updateClaimed(subject, runId, change);
      return true;
    } catch (error) {
      const failure = `${label}: not recorded, the next sweep decides it again (${message(error)})`;
      note(`merge-queue record: ${failure}`);
      lines.push(failure);
      return false;
    }
  };

  for (const { decision, status, reason } of outcomes) {
    const item = itemOf(decision.number);
    const name = `PR ${String(decision.number)}`;
    const isAsked = asked?.by === 'pr' && asked.pr.number === decision.number;
    const raised = isAsked && status === 'waiting';
    // The pull request was merged or closed under the question: there is nothing to ask.
    if (isAsked && !raised) asked = null;
    const label = raised ? 'ask' : decision.action === 'ask' ? 'ask (not raised this run)' : status === 'merged' ? 'merged' : decision.action;
    const entry: MergeDecisionEntry = {
      at,
      run_id: runId,
      decision: `${label} (${[decision.class, ...(decision.synced ? ['synced'] : [])].join(', ')})`,
      reason,
      links: [item.url, ...(decision.attention?.links ?? [])],
      head: decision.head,
      reran: decision.reran,
    };
    const written = write(item.item as QualifiedPr, name, doc => {
      const recorded = withMerge(doc, {
        at,
        run_id: runId,
        entry,
        status: raised ? 'asking' : status,
        pr: item.pr,
        release: !raised,
      });
      return status === 'returned'
        ? withBuild(recorded, {
            at,
            run_id: runId,
            round: null,
            entry: { ...entry, decision: 'returned by the merge queue' },
            status: 'next',
            brief: decision.brief,
            release: true,
          })
        : recorded;
    });
    if (status === 'merged') merged.push(decision.number);
    if (!written) {
      if (raised) asked = null;
      continue;
    }
    lines.push(`${name}: ${label}`);
  }
  for (const done of settled) {
    const name = `Issue ${String(done.item.number)}`;
    const written = write(done.item, name, doc =>
      withMerge(doc, {
        at,
        run_id: runId,
        entry: { at, run_id: runId, decision: done.decision, reason: done.reason, links: [], head: null, reran: false },
        status: done.status,
        pr: done.pr,
        release: true,
      })
    );
    if (written) lines.push(`${name}: ${done.status}`);
  }

  emit({
    merged,
    summary: [sweep?.summary ?? '', ...lines].filter(line => line !== '').join('\n'),
    attention: render(asked),
    options: asked === null ? [] : attentionOptions<string>(asked.attention),
    class: asked?.by ?? '',
    asked,
    evaluation: null,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue record: ${message(error)}`);
}
