/**
 * The lines a board card adds to Rasmus's card: what runs now, the check rounds, how often the
 * item was sent back, its pull request, and its open asks with the recommended option. Each
 * line comes from `cardProgress` (`lib/item-card.ts`); this file only draws it, in the Visual
 * standard's type, colours and ask rules (rules 1, 5 and 9). Ported from v1's `BoardCard.tsx`
 * and `BoardCardAsk.tsx` (`origin/main`).
 */
import type { ReactElement, ReactNode } from 'react';
import type { ItemRead } from '../skills/items';
import { useFactoryCards } from './cards-context';
import type { CardProgress } from './lib/item-card';
import type { RoundVerdict } from './lib/run-facts';

/** Above the card-wide link to the run log, so a press here does not open it. */
export const INNER = 'relative z-10';

const VERDICT_DOT: Record<RoundVerdict, string> = {
  approved: 'bg-success',
  returned: 'bg-error',
  undecided: 'bg-warning',
  running: 'bg-[color:var(--running)]',
  stopped: 'bg-text-tertiary/60',
};

const VERDICT_WORDS: Record<RoundVerdict, string> = {
  approved: 'approved',
  returned: 'returned',
  undecided: 'needs a decision',
  running: 'running',
  stopped: 'stopped',
};

function RoundDots({ round }: { round: NonNullable<CardProgress['round']> }): ReactElement {
  return (
    <span
      data-card-rounds
      className="flex items-center gap-1.5 text-console-12 text-text-secondary"
    >
      <span className="flex items-center gap-0.5">
        {round.dots.map(dot => {
          const label = `round ${String(dot.iteration)}: ${VERDICT_WORDS[dot.verdict]}`;
          return (
            <span
              key={dot.iteration}
              role="img"
              aria-label={label}
              title={label}
              className={`inline-block h-1.5 w-1.5 rounded-full ${VERDICT_DOT[dot.verdict]}`}
            />
          );
        })}
      </span>
      {round.text}
    </span>
  );
}

/** "sent back 2x" with the latest reason on hover, and the pull request. */
function ReturnsAndPr({ progress }: { progress: CardProgress }): ReactNode {
  const { returned, pr } = progress;
  if (returned === null && pr === null) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-console-13">
      {returned === null ? null : (
        <span
          data-card-returned
          title={returned.reason ?? undefined}
          className={`${INNER} text-text-secondary`}
        >
          {returned.text}
        </span>
      )}
      {pr === null ? null : (
        <a
          data-card-pr
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className={`${INNER} text-accent-bright hover:underline`}
        >
          {pr.number === null ? 'Pull request' : `PR #${String(pr.number)}`}
        </a>
      )}
    </span>
  );
}

/** The warning dot an open ask carries; under reduced motion only the dot stays. */
function AskDot(): ReactElement {
  return (
    <span aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inset-0 rounded-full bg-warning motion-safe:animate-ping" />
      <span className="relative h-2 w-2 rounded-full bg-warning" />
    </span>
  );
}

/**
 * The open asks (rule 9): the first question on one line behind the ping, then "Recommended:
 * <label>" in green, or a neutral "No recommendation", and the "N open asks" chip. The whole
 * block is one button opening Archon's ask section in the popover.
 */
function CardAsks({ read, progress }: { read: ItemRead; progress: CardProgress }): ReactNode {
  const cards = useFactoryCards();
  const { asks } = progress;
  if (asks === null || cards === null) return null;
  const words = `${String(asks.count)} open ask${asks.count === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      data-card-asks={read.item.id}
      aria-haspopup="dialog"
      aria-expanded={cards.open?.read.item.id === read.item.id}
      aria-label={`${words}: ${asks.question}`}
      onClick={event => {
        cards.setOpen({
          read,
          title: progress.title,
          keyText: progress.keyText,
          trigger: event.currentTarget,
        });
      }}
      className={`${INNER} flex min-w-0 max-w-full cursor-pointer flex-col items-start gap-2 rounded border border-transparent p-1 -m-1 text-left transition-colors hover:border-border-bright hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <AskDot />
        <span title={asks.question} className="min-w-0 truncate text-console-13 text-text-primary">
          {asks.question}
        </span>
      </span>
      <span className="flex max-w-full flex-wrap items-center gap-2">
        {asks.recommended === 'none' ? (
          <span data-card-no-recommendation className="text-console-12 text-text-tertiary">
            No recommendation
          </span>
        ) : (
          <span
            data-card-recommended
            className="max-w-full cursor-pointer rounded-console-12 border bg-[color:var(--success-soft)] px-2 py-1 transition-colors hover:brightness-125 text-console-12 text-text-primary [overflow-wrap:anywhere]"
            // Inline: theme.css sets border-color on `.console-root *` outside Tailwind's layers.
            style={{ borderColor: 'color-mix(in oklab, var(--success) 40%, transparent)' }}
          >
            Recommended: {asks.recommended.label}
          </span>
        )}
        <span
          data-card-open-asks
          className="cursor-pointer rounded-console-12 border border-border bg-surface-inset px-2 py-1 text-console-12 text-text-primary transition-colors hover:border-border-bright hover:bg-surface-elevated"
        >
          {words}
        </span>
      </span>
    </button>
  );
}

/** Everything the card shows beyond Rasmus's lines, in DESIGN's order. */
export function BoardCardProgress({
  read,
  progress,
}: {
  read: ItemRead;
  progress: CardProgress;
}): ReactElement {
  const { running } = progress;
  return (
    <>
      {running === null ? null : (
        <span
          data-card-running
          className="min-w-0 truncate text-console-13 text-[color:var(--running)]"
          title={running.step === null ? running.stage : `${running.stage} · ${running.step}`}
        >
          {running.stage}
          {running.step === null ? '' : ` · ${running.step}`}
        </span>
      )}
      {progress.round === null ? null : <RoundDots round={progress.round} />}
      <ReturnsAndPr progress={progress} />
      {progress.unread ? (
        <span data-card-unread className="text-console-12 text-text-tertiary">
          Progress could not be read
        </span>
      ) : null}
      <CardAsks read={read} progress={progress} />
    </>
  );
}
