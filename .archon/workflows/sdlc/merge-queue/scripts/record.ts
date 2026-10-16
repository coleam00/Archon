/**
 * Check the sweep's decisions, read back what it did, and record one decision per item.
 *
 * Every claimed pull request gets exactly one decision, and the forge, not the sweep,
 * says which were merged: a pull request reads back merged or it was not. One the sweep
 * says it merged must also carry the gate's receipt at the head it names. A `return`
 * hands the item back to the build queue with its brief. A run raises at most one
 * attention item: a red default branch first, because it holds every merge, otherwise
 * the first pull request the sweep asked about, in its order. That item keeps its
 * claim while the run waits; every other claim is released, and an ask that was not
 * raised waits for the next sweep, which decides it again.
 *
 * Eval writes nothing and returns the decisions, with the attention item live would
 * raise, as `evaluation`.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEMS and INPUTS_SETTLED from facts; INPUTS_SWEEP,
 * the sweep's whole output, "null" when it was skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBuild } from '../../.shared/build.ts';
import type { QualifiedPr } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import {
  type DevAttention,
  type MergeAskedBy,
  type MergeAttention,
  type MergeRecord,
  type MergeStatus,
  type PrFacts,
  type Receipt,
  readPr,
  type SweepAction,
  withMerge,
} from '../../.shared/merge.ts';
import { attentionOptions, checkAttention, type DecisionEntry, renderAttention } from '../../.shared/queue.ts';
import { parseMode, readMaintainers, updateClaimed } from '../../.shared/workitem.ts';

interface Item {
  readonly item: QualifiedPr | null;
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly facts: PrFacts | null;
  readonly record: MergeRecord | null;
}

interface Settled {
  readonly item: QualifiedPr;
  readonly pr: QualifiedPr | null;
  readonly status: 'merged' | 'parked';
  readonly reason: string;
}

interface Decision {
  readonly number: number;
  readonly action: SweepAction;
  readonly class: 'clear' | 'unclear';
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
    readonly state: 'unchecked' | 'green' | 'red';
    readonly rerun: 'none' | 'green' | 'red';
    readonly summary: string;
    readonly attention: DevAttention | null;
  };
  readonly summary: string;
}

/** What the ruling node needs to act on the answer. */
type Asked =
  | {
      readonly by: Extract<MergeAskedBy, 'pr'>;
      readonly item: QualifiedPr;
      readonly pr: QualifiedPr;
      readonly head: string;
      readonly brief: string;
      readonly attention: MergeAttention;
    }
  | { readonly by: Extract<MergeAskedBy, 'dev'>; readonly attention: DevAttention };

/** Refuse a sweep output the queue cannot act on, before anything is written. */
function check(items: readonly Item[], sweep: Sweep): void {
  const wanted = new Set(items.map(item => item.pr.number));
  const seen = new Set<number>();
  for (const decision of sweep.decisions) {
    const name = `PR ${String(decision.number)}`;
    if (!wanted.has(decision.number)) throw new Error(`the sweep decided ${name}, which this run did not claim`);
    if (seen.has(decision.number)) throw new Error(`the sweep decided ${name} twice`);
    seen.add(decision.number);
    if ((decision.action === 'ask') !== (decision.attention !== null)) {
      throw new Error(`${name}: an attention item comes with an ask and only with one`);
    }
    if (decision.attention !== null) checkAttention(decision.attention);
    if (decision.action === 'return' && decision.brief.trim() === '') {
      throw new Error(`${name}: a return has no brief for the build queue`);
    }
  }
  const missing = [...wanted].filter(number => !seen.has(number));
  if (missing.length > 0) throw new Error(`the sweep left PR ${missing.join(', ')} undecided`);
  if (sweep.review_url !== '') {
    const reviewed = sweep.decisions.find(decision => items.find(item => item.pr.number === decision.number)?.url === sweep.review_url);
    if (reviewed?.action !== 'review') throw new Error(`the delta review names ${sweep.review_url}, which the sweep did not send to review`);
  }
  if ((sweep.dev.state === 'red') !== (sweep.dev.attention !== null)) {
    throw new Error('an attention item on the default branch comes with a red one and only with one');
  }
  if (sweep.dev.attention !== null) checkAttention(sweep.dev.attention);
}

function receiptOf(number: number): Receipt | null {
  const path = join(artifactsDir(), 'merge', 'receipts', `${String(number)}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Receipt) : null;
}

/** The status and reason the forge's read-back supports for one decision. */
function settle(decision: Decision, after: PrFacts): { status: MergeStatus; reason: string } {
  if (after.state === 'merged') {
    const receipt = receiptOf(decision.number);
    const gated = receipt !== null && receipt.head === after.head_revision;
    return {
      status: 'merged',
      reason: `${decision.reason} (merged ${after.merge_commit ?? ''} at ${after.head_revision}${gated ? '' : '; no gate receipt: merged outside this run'})`,
    };
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

function main(): void {
  const mode = parseMode(text(process.env.INPUTS_MODE));
  const path = trimmed(process.env.INPUTS_PATH);
  const items = (nullableJson(process.env.INPUTS_ITEMS) ?? []) as Item[];
  const settled = (nullableJson(process.env.INPUTS_SETTLED) ?? []) as Settled[];
  const sweep = nullableJson(process.env.INPUTS_SWEEP) as Sweep | null;
  const idle = {
    merged: [],
    summary: 'No pull request waits for the merge queue.',
    attention: '',
    options: [],
    class: '',
    asked: null,
    evaluation: null,
  };
  if (path === 'idle') {
    emit(idle);
    return;
  }
  if (path === 'sweep' && sweep === null) throw new Error('the sweep path reached record with no sweep');
  const decisions = sweep?.decisions ?? [];
  if (sweep !== null) check(items, sweep);
  const itemOf = (number: number): Item => items.find(item => item.pr.number === number) as Item;

  const asks = decisions.filter(decision => decision.attention !== null);
  const devAttention = sweep?.dev.attention ?? null;
  const firstAsk = asks[0];
  let asked: Asked | null =
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
  const render = (raised: Asked | null): string =>
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

  for (const decision of decisions) {
    const item = itemOf(decision.number);
    if (item.item === null) throw new Error(`PR ${String(decision.number)} has no work item`);
    const after = readPr(item.pr, maintainers).facts;
    const { status, reason } = settle(decision, after);
    const raised = asked?.by === 'pr' && asked.pr.number === decision.number && status === 'waiting';
    // The pull request was merged or closed under the question: there is nothing to ask.
    if (asked?.by === 'pr' && asked.pr.number === decision.number && !raised) asked = null;
    const label = raised ? 'ask' : decision.action === 'ask' ? 'ask (not raised this run)' : status === 'merged' ? 'merged' : decision.action;
    const entry: DecisionEntry = {
      at,
      run_id: runId,
      decision: `${label} (${[decision.class, ...(decision.synced ? ['synced'] : []), ...(decision.reran ? ['reran failed checks'] : [])].join(', ')})`,
      reason,
      links: [item.url, ...(decision.attention?.links ?? [])],
    };
    if (status === 'merged') merged.push(decision.number);
    updateClaimed(item.item, runId, doc => {
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
    lines.push(`PR ${String(decision.number)}: ${label}`);
  }
  for (const done of settled) {
    updateClaimed(done.item, runId, doc =>
      withMerge(doc, {
        at,
        run_id: runId,
        entry: { at, run_id: runId, decision: done.status, reason: done.reason, links: [] },
        status: done.status,
        pr: done.pr,
        release: true,
      })
    );
    lines.push(`Issue ${String(done.item.number)}: ${done.status}`);
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
  refuse(`merge-queue record: ${error instanceof Error ? error.message : String(error)}`);
}
