/**
 * One item on the board, and a list of them. The card is Rasmus's (how its run stands, why it
 * needs a decision, the link to a run that waits for an answer) with the iteration detail v1's
 * cards carried (`factory/BoardCardProgress.tsx`). Top right is the item's state as a label,
 * never a control. The card's actions are buttons in a row at its bottom (owner, 11/26): its
 * pull request, and for an item with open asks one "Needs you · N" button linking to the
 * project's Needs you tab filtered to it (`factory/NeedsYouLink.tsx`). There is no item page:
 * the rest of the card opens the run log of the run the item stands at, else its newest run.
 */
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { BoardCardProgress, CARD_BUTTON, CardPrButton } from '../../factory/BoardCardProgress';
import { useCardList } from '../../factory/FactoryCards';
import type { CardProgress } from '../../factory/lib/item-card';
import { NeedsYouLink } from '../../factory/NeedsYouLink';
import { relativeTime } from '../../lib/format';
import type { ItemRead } from '../../skills/items';
import {
  CHIP,
  decisionReason,
  howItEnded,
  needsDecision,
  runPath,
  runToOpen,
  standingRun,
} from './standing';

/**
 * How a card reads under a highlighted work order (`lit`, the ids of its members): a member
 * gets the accent border, any other card dims. Important (!): theme.css's unlayered
 * `.console-root *` border colour outranks every border utility.
 */
function litShade(
  lit: ReadonlySet<string> | null | undefined,
  id: string
): { border: string; dimmed: '' | undefined } {
  if (lit == null) return { border: 'border-border', dimmed: undefined };
  if (lit.has(id)) return { border: 'border-accent-bright!', dimmed: undefined };
  return { border: 'border-border opacity-40', dimmed: '' };
}

export function ItemCard({
  read,
  projectId,
  stage,
  progress,
  lit,
  accent,
}: {
  accent?: string;
  read: ItemRead;
  projectId: string;
  /** The exact stage, shown when the card's column holds more than one. */
  stage?: string;
  progress: CardProgress;
  /** The ids of a highlighted work order's members; null or absent when none is. */
  lit?: ReadonlySet<string> | null;
}): ReactElement {
  const run = standingRun(read);
  const open = runToOpen(read);
  const shade = litShade(lit, read.item.id);
  const reason = needsDecision(read) ? decisionReason(read) : undefined;
  const meta = [
    stage,
    run === undefined
      ? undefined
      : `${run.outcome === null ? run.status : `ended ${run.outcome}`} · ${relativeTime(run.completedAt ?? run.startedAt)}`,
    read.merged === null ? undefined : 'merged',
  ].filter(part => part !== undefined);
  return (
    <li
      data-item={read.item.key}
      data-state={read.standing.state}
      data-dimmed={shade.dimmed}
      className={`relative flex shrink-0 flex-col gap-2 overflow-hidden rounded-console-12 border ${shade.border} bg-surface p-3 ${open === undefined ? '' : 'motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:border-border-bright hover:bg-surface-elevated'}`}
    >
      {accent === undefined ? null : (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.75"
          style={{ background: accent }}
        />
      )}
      {open === undefined ? null : (
        <Link
          data-card-link
          to={runPath(projectId, open.id)}
          aria-label={`${progress.keyText}: open its run log`}
          className="absolute inset-0 rounded-console-12"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <span data-item-key className="truncate font-mono text-console-12 text-text-tertiary">
          {progress.keyText}
        </span>
        <StateLabel read={read} />
      </div>
      {progress.titleIsKey ? null : (
        <p
          data-item-title
          className={`line-clamp-3 text-console-15 font-semibold leading-snug text-text-primary`}
        >
          {progress.title}
        </p>
      )}
      {meta.length === 0 ? null : (
        <p className="text-console-13 text-text-tertiary">{meta.join(' · ')}</p>
      )}
      <BoardCardProgress progress={progress} />
      {reason === undefined ? null : (
        <p data-item-reason className="text-console-13 text-text-secondary">
          {reason}
        </p>
      )}
      <CardActions read={read} projectId={projectId} progress={progress} />
    </li>
  );
}

/**
 * The card's actions, a row of buttons at its bottom: the PR, "Needs you · N" for open asks,
 * and a run that waits for an answer. Nothing when it has none. Keyed on the asks, not the
 * state: an item can wait with an open ask its standing names no question for. Each button
 * sits above the card-wide link on its own, so the row's gaps still open the run log.
 */
function CardActions({
  read,
  projectId,
  progress,
}: {
  read: ItemRead;
  projectId: string;
  progress: CardProgress;
}): ReactElement | null {
  const [heldByRun] = read.questions.flatMap(question =>
    'run' in question && question.run !== undefined ? [question.run] : []
  );
  if (progress.pr === null && progress.asks === null && heldByRun === undefined) return null;
  return (
    <div data-card-actions className="mt-1 flex flex-wrap items-center gap-2">
      <CardPrButton pr={progress.pr} />
      {progress.asks === null ? null : (
        <NeedsYouLink projectId={projectId} itemKey={read.item.key} count={progress.asks.count} />
      )}
      {heldByRun === undefined ? null : (
        <Link to={runPath(projectId, heldByRun.id)} className={CARD_BUTTON}>
          Its run waits for an answer
        </Link>
      )}
    </div>
  );
}

/**
 * The item's state as a label (Running, Waiting, Merged, Stopped…): drawn so it does not read
 * as a control. An item's asks are its Needs you button, never this label.
 */
export function StateLabel({ read }: { read: ItemRead }): ReactElement {
  const { state } = read.standing;
  return (
    <span
      data-chip={state}
      className={`shrink-0 select-none whitespace-nowrap rounded px-1.5 py-0.5 text-console-12 font-medium ${CHIP[state].tone}`}
    >
      {state === 'done' ? howItEnded(read) : CHIP[state].label}
    </span>
  );
}

/** A list of cards, their run records and forge answers read in one batch. */
export function CardList({
  reads,
  projectId,
  stageOf,
  className,
  lit,
  accent,
}: {
  accent?: string;
  reads: ItemRead[];
  projectId: string;
  stageOf?: (read: ItemRead) => string | undefined;
  className: string;
  lit?: ReadonlySet<string> | null;
}): ReactElement {
  const progressOf = useCardList(reads);
  return (
    <ul className={className}>
      {reads.map(read => (
        <ItemCard
          key={read.item.id}
          read={read}
          projectId={projectId}
          stage={stageOf?.(read)}
          progress={progressOf(read)}
          lit={lit}
          accent={accent}
        />
      ))}
    </ul>
  );
}
