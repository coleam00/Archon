/**
 * The lines a board card adds to Rasmus's card: what runs now, the check rounds and how often
 * the item was sent back, and its pull request as a button (`CardPrButton`) for the card's
 * actions row. Each comes from `cardProgress` (`lib/item-card.ts`); this file only draws it, in
 * the Visual standard's type and colours (rules 1 and 5). Open asks are not drawn here: the
 * card's one Needs you button (`NeedsYouLink.tsx`) sits beside the PR in the actions row.
 * Ported from v1's `BoardCard.tsx` (`origin/main`).
 */
import type { ReactElement, ReactNode } from 'react';
import type { CardProgress } from './lib/item-card';
import type { RoundVerdict } from './lib/run-facts';

/** Above the card-wide link to the run log, so a press here does not open it. */
export const INNER = 'relative z-10';

/** A secondary button among a card's actions: the PR, a run that waits for an answer. */
export const CARD_BUTTON = `${INNER} inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-md border border-border px-2 py-1 text-console-12 text-text-secondary motion-safe:transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright`;

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

/** "sent back 2x", with the latest reason on hover. */
function Returned({ progress }: { progress: CardProgress }): ReactNode {
  const { returned } = progress;
  if (returned === null) return null;
  return (
    <span
      data-card-returned
      title={returned.reason ?? undefined}
      className={`${INNER} self-start text-console-13 text-text-secondary`}
    >
      {returned.text}
    </span>
  );
}

/** The item's pull request, as a button among the card's actions; nothing when it has none. */
export function CardPrButton({ pr }: { pr: CardProgress['pr'] }): ReactNode {
  if (pr === null) return null;
  return (
    <a data-card-pr href={pr.url} target="_blank" rel="noreferrer" className={CARD_BUTTON}>
      {pr.number === null ? 'Pull request' : `PR #${String(pr.number)}`}
    </a>
  );
}

/** Everything the card shows beyond Rasmus's lines, in DESIGN's order. */
export function BoardCardProgress({ progress }: { progress: CardProgress }): ReactElement {
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
      <Returned progress={progress} />
      {progress.unread ? (
        <span data-card-unread className="text-console-12 text-text-tertiary">
          Progress could not be read
        </span>
      ) : null}
    </>
  );
}
