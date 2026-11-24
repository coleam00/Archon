import type { ReactElement, ReactNode } from 'react';
import { Ping } from '../components/ask-card/Ping';
import { markProps, RECOMMENDED_BG } from '../components/ask-card/tile-marks';
import type { BoardCard } from './lib/board';
import type { BoardAskFace as Face } from './lib/board-ask';
import type { BoardAsks } from './useBoardAsks';

/**
 * A card's stop line, as the board card and the Table row both draw it: what stopped a failed
 * item or what an item asks, in two lines at most. With several questions (`stopCount`), the
 * first is cut to one line and the count stands beside it, as the ask face does, so the count
 * is never clamped away; the whole line is on hover.
 */
function StopText({
  card,
  as: Tag = 'span',
  className = '',
}: {
  card: Pick<BoardCard, 'stopLine' | 'stopCount'>;
  as?: 'p' | 'span';
  className?: string;
}): ReactNode {
  if (card.stopLine === null) return null;
  if (card.stopCount === null)
    return (
      <Tag title={card.stopLine} className={`line-clamp-2 ${className}`}>
        {card.stopLine}
      </Tag>
    );
  return (
    <Tag
      title={`${card.stopLine} · ${card.stopCount}`}
      className={`flex min-w-0 items-baseline gap-2 ${className}`}
    >
      <span className="min-w-0 truncate">{card.stopLine}</span>
      <span data-stop-count="" className="shrink-0 text-text-secondary">
        {card.stopCount}
      </span>
    </Tag>
  );
}

/** What stopped a failed item, or what an item that needs you asks, on the card. */
function StopLine({ card }: { card: BoardCard }): ReactNode {
  const tone = card.pill === 'failed' ? 'text-error' : 'text-warning';
  return <StopText card={card} as="p" className={`text-console-13 ${tone}`} />;
}

/**
 * The open ask's face a card draws, or null: none once an answer given from the board stands,
 * for an item that does not need you, or until the project's queue holds the item's asks.
 * The card shortens its title while a face shows, so `CardAsk` and the card ask this once.
 */
export function shownAsk(card: BoardCard, asks: BoardAsks): ReturnType<BoardAsks['faceOf']> {
  if (card.pill !== 'needs-you' || asks.answeredLine(card.key) !== null) return null;
  return asks.faceOf(card.key);
}

/**
 * The foot of a board card: an answer given from the board while it stands, else the open
 * ask's face for an item that needs you, else the card's stop line. Until the project's queue
 * is read (or while it holds nothing for the item the item read still lists), the stop line
 * stays: the face draws only what the popover can answer.
 */
export function CardAsk({ card, asks }: { card: BoardCard; asks: BoardAsks }): ReactNode {
  const answered = asks.answeredLine(card.key);
  if (answered !== null)
    return (
      <p role="status" className="text-console-13 text-success">
        {answered}
      </p>
    );
  const shown = shownAsk(card, asks);
  if (shown === null) return <StopLine card={card} />;
  return (
    <>
      <AskFace itemKey={card.key} face={shown.face} asks={asks} />
      {shown.unread ? <StopLine card={card} /> : null}
    </>
  );
}

/**
 * The approval card's face (DESIGN.md, owner change 3; Visual standard rules 7 and 9): on one
 * line the ping, the first ask's question cut to that line, and "N questions" when there are
 * several; under it the line Needs you shows for the ask. One control opening the ask in place,
 * where the whole question reads, so the card stays short enough for the board's columns. It
 * sits above the title's stretched link, so the rest of the card still opens the item page.
 */
function AskFace({
  itemKey,
  face,
  asks,
}: {
  itemKey: string;
  face: Face;
  asks: BoardAsks;
}): ReactElement {
  const several = face.count >= 2 ? `${face.count.toString()} questions` : null;
  return (
    <button
      type="button"
      data-ask-trigger={itemKey}
      aria-haspopup="dialog"
      aria-expanded={asks.open?.key === itemKey}
      aria-label={`Answer: ${face.question}${several === null ? '' : ` (${several})`}`}
      onClick={event => {
        asks.openFor(itemKey, event.currentTarget);
      }}
      className="relative z-10 flex min-w-0 max-w-full flex-col items-start gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <Ping />
        <span title={face.question} className="min-w-0 truncate text-console-13 text-text-primary">
          {face.question}
        </span>
        {several === null ? null : (
          <span className="shrink-0 whitespace-nowrap text-console-12 text-text-tertiary">
            {several}
          </span>
        )}
      </span>
      <span
        title={face.tile.detail}
        className={`max-w-full rounded-console-12 border px-2 py-1 text-console-12 text-text-primary transition-colors duration-150 ease-out [overflow-wrap:anywhere] ${
          face.tile.recommended ? RECOMMENDED_BG : 'border-border hover:border-border-bright'
        }`}
        {...markProps(false, face.tile.recommended)}
      >
        {face.line}
      </span>
    </button>
  );
}

/** The Table's "Stopped by or asks" cell: the answer given from the board while it stands, else the stop line. */
export function RowAsk({ card, asks }: { card: BoardCard; asks: BoardAsks }): ReactNode {
  const answered = asks.answeredLine(card.key);
  if (answered !== null)
    return (
      <span role="status" className="text-success">
        {answered}
      </span>
    );
  return <StopText card={card} />;
}

/**
 * The Answer button a Table row that needs you shows beside its state pill, opening the same
 * popover the card's face does. It sits in the State cell, not with the question in the last
 * column, so it is in view without scrolling the Table sideways.
 */
export function RowAnswer({ card, asks }: { card: BoardCard; asks: BoardAsks }): ReactNode {
  const askable = card.pill === 'needs-you' && (asks.asksOf(card.key)?.length ?? 0) > 0;
  if (!askable || asks.answeredLine(card.key) !== null) return null;
  return (
    <button
      type="button"
      data-ask-trigger={card.key}
      aria-haspopup="dialog"
      aria-expanded={asks.open?.key === card.key}
      onClick={event => {
        asks.openFor(card.key, event.currentTarget);
      }}
      className="rounded-console-12 border border-border px-2 py-0.5 text-console-12 font-medium text-text-primary transition-colors duration-150 ease-out hover:border-border-bright hover:bg-surface-elevated"
    >
      Answer
    </button>
  );
}
