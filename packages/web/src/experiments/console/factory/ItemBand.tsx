import type { ReactElement, ReactNode } from 'react';
import { GitPullRequest } from 'lucide-react';
import { SkeletonLine } from '../components/Skeleton';
import { formatCost } from '../lib/format';
import type { FactoryItem, FactoryItemDetail } from '../skills/factory';
import { PillBadge } from './BoardCard';
import { HeaderBand, StatChip } from './document';
import type { Pill } from './lib/board';
import { durationWords } from './lib/duration';
import type { Journey } from './lib/item-journey';
import type { ItemColumn } from './lib/placement';
import { displayKeyOf, NOT_STARTED, orderTitle } from './lib/work-orders';
import { WORK_ORDER_WORDS } from './ItemWorkOrder';

const UNTIL: Record<Journey['until'], string> = {
  merge: 'order to merge',
  stop: 'order to where it stopped',
  now: 'order to now',
};

/**
 * The item page's header band (owner change 8): the item's number and title, the state pill its
 * board card shows, its pull request as a button, one sentence of where it is, and its key facts
 * as chips: time from order to merge (or to now), cost, check rounds used of allowed, asks
 * answered. A work order with no run of its own, or an item no run has started, says so instead.
 */
export function ItemBand({
  detail,
  pill,
  pillLabel,
  column,
  journey,
  workOrder = false,
}: {
  detail: FactoryItemDetail;
  pill: Pill;
  /** The pill's words, as `itemPill` gives them (an `awaits` item's declared label). */
  pillLabel: string;
  /** Where `placement.ts` puts the item; null when no declared stage holds it. */
  column: ItemColumn | null;
  journey: Journey;
  workOrder?: boolean;
}): ReactElement {
  const { item } = detail;
  const title =
    item.progress?.title ?? (workOrder ? orderTitle(item.item.key) : displayKeyOf(item));
  const started = item.runs.length > 0;
  return (
    <HeaderBand
      className="lg:col-span-2"
      title={
        <>
          <span className="mr-2 font-mono text-text-tertiary">{displayKeyOf(item)}</span>
          {title}
        </>
      }
      sentence={
        workOrder
          ? WORK_ORDER_WORDS
          : started
            ? whereWords(item, pill, column, journey.stopped)
            : NOT_STARTED
      }
      aside={
        workOrder || !started ? undefined : (
          <div className="flex flex-wrap items-center gap-3">
            <PillBadge pill={pill} label={pillLabel} />
            <ChangeLink change={item.progress?.change ?? null} />
          </div>
        )
      }
      chips={workOrder || !started ? null : <BandChips detail={detail} journey={journey} />}
    />
  );
}

function BandChips({
  detail,
  journey,
}: {
  detail: FactoryItemDetail;
  journey: Journey;
}): ReactElement {
  const costs = detail.runs.flatMap(run => run.costUsd ?? []);
  const round = detail.item.progress?.round ?? null;
  const answered = detail.item.answers.filter(
    answer => (answer.kind === 'ask' && !answer.withdrawn) || answer.kind === 'attention'
  ).length;
  return (
    <>
      <StatChip figure={durationWords(journey.totalMs)} label={UNTIL[journey.until]} />
      <StatChip
        figure={costs.length === 0 ? '-' : formatCost(costs.reduce((sum, cost) => sum + cost, 0))}
        label="cost"
      />
      {round === null ? null : (
        <StatChip
          figure={
            round.max === null ? String(round.iteration) : `${round.iteration} of ${round.max}`
          }
          label="check rounds"
        />
      )}
      <StatChip figure={answered} label={answered === 1 ? 'ask answered' : 'asks answered'} />
    </>
  );
}

/**
 * Where the item is, in one sentence: merged, ended, waiting on you (its declared label and
 * reason), parked, or the stage it is in.
 */
function whereWords(
  item: FactoryItem,
  pill: Pill,
  column: ItemColumn | null,
  stopped: string | null
): string {
  if (pill === 'landed') return 'Its change merged.';
  if (item.progress === null || column === null) return 'Where it is could not be worked out.';
  if ('ended' in column) return `${column.ended}.`;
  const { awaits, parked } = item.progress;
  if (pill === 'awaits' && awaits !== null)
    return awaits.why === null ? `${awaits.label}.` : `${awaits.label}: ${awaits.why}`;
  if (parked !== null)
    return parked.why === null ? `${parked.label}.` : `${parked.label}: ${parked.why}`;
  // Failed, stopped or held: it rests in its stage until someone starts it again.
  if (stopped !== null) return `${stopped}, in ${column.stage.label}.`;
  return `In ${column.stage.label} now.`;
}

type Change = NonNullable<NonNullable<FactoryItem['progress']>['change']>;

/** What the change's merge state reads, once the host answered. */
function mergeWords(merged: true | false | 'unknown'): string {
  if (merged === true) return 'merged';
  if (merged === false) return 'open';
  return 'merge state unknown';
}

/** Whether the change merged, as quiet words after its link; a skeleton line while asked. */
function MergeState({ merged }: { merged: Change['merged'] }): ReactElement {
  if (merged === 'pending')
    return (
      <span className="inline-flex w-20 items-center" data-merge-state="pending">
        <SkeletonLine />
        <span className="sr-only">checking whether it merged</span>
      </span>
    );
  return (
    <span
      data-merge-state={String(merged)}
      className="whitespace-nowrap text-console-13 text-text-tertiary"
    >
      {mergeWords(merged)}
    </span>
  );
}

/**
 * The pull request as a button-style link ("PR #n" when the URL ends in a number, else the
 * URL), then whether it merged. Unlinked "the change" while the change host has not named the
 * pull request (no URL yet).
 */
function ChangeLink({ change }: { change: Change | null }): ReactNode {
  if (change === null)
    return <span className="text-console-13 text-text-tertiary">No change yet</span>;
  const number = change.url === null ? undefined : /\/(\d+)\/?$/.exec(change.url)?.[1];
  return (
    <span className="flex items-center gap-2">
      {change.url === null ? (
        <span className="text-console-13 text-text-secondary">the change</span>
      ) : (
        <a
          href={change.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-console-13 font-medium text-text-primary transition-colors duration-150 ease-out hover:border-border-bright hover:bg-surface-elevated"
        >
          <GitPullRequest aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
          {number === undefined ? change.url : `PR #${number}`}
        </a>
      )}
      <MergeState merged={change.merged} />
    </span>
  );
}
