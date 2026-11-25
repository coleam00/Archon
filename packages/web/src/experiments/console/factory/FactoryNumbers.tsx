/**
 * A pack's number tiles on the Overview (v1's `FactoryNumbers.tsx`): in flight, need you,
 * merged today, "N of M" merged and the median time to merged. Every figure but "need you" is
 * `packBoard`'s, the function the Board's columns and Merged column count with, so the two
 * pages cannot disagree. "Need you" is the project's open asks, the same count the project's
 * Needs you tab badge and the Overview's Needs you line show.
 */
import type { ReactElement, ReactNode } from 'react';
import {
  Activity,
  CircleCheck,
  GitMerge,
  type LucideIcon,
  MessageCircleQuestionMark,
  Timer,
} from 'lucide-react';
import type { BoardNumbers } from './lib/board-numbers';
import { durationWords } from './lib/duration';

interface Tile {
  name: string;
  label: string;
  icon: LucideIcon;
  /** The figure; null while it is read. */
  value: string | null;
  /** What the number means, as the tile's tooltip. */
  means?: string;
}

function tiles(numbers: BoardNumbers | undefined, needYou: number | undefined): Tile[] {
  const of = (value: (n: BoardNumbers) => string): string | null =>
    numbers === undefined ? null : value(numbers);
  return [
    {
      name: 'in-flight',
      label: 'in flight',
      icon: Activity,
      value: of(n => String(n.inFlight)),
      means: 'Items on a stage: running, waiting or queued',
    },
    {
      name: 'need-you',
      label: needYou === 1 ? 'needs you' : 'need you',
      icon: MessageCircleQuestionMark,
      value: needYou === undefined ? null : String(needYou),
    },
    {
      name: 'merged-today',
      label: 'merged today',
      icon: GitMerge,
      value: of(n => String(n.mergedToday)),
    },
    {
      name: 'merged',
      label: 'merged',
      icon: CircleCheck,
      value: of(n => `${String(n.merged)} of ${String(n.total)}`),
      means: 'Items whose change merged, of every item on the board; the items set aside are not',
    },
    {
      name: 'median-to-merged',
      label: 'median to merged',
      icon: Timer,
      value: of(n =>
        n.medianToMergedMs === null ? 'none yet' : durationWords(n.medianToMergedMs)
      ),
      means: "The median time from an item's first run starting to its change merging",
    },
  ];
}

export function FactoryNumbers({
  numbers,
  needYou,
  error,
}: {
  /** Undefined while every item is read. */
  numbers: BoardNumbers | undefined;
  /** The project's open asks; undefined until the attention list answers. */
  needYou: number | undefined;
  /** The every-item read failed. */
  error: Error | undefined;
}): ReactElement {
  // A failed read says so in words; skeletons would read as loading that never ends.
  if (numbers === undefined && error !== undefined)
    return (
      <p role="alert" className="text-console-14 text-error">
        The numbers could not be read: {error.message}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <ul data-numbers aria-label="Numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles(numbers, needYou).map(tile => (
          <NumberTile key={tile.name} tile={tile}>
            {tile.value === null ? (
              <span title="Reading" className="inline-flex items-center">
                <span className="inline-block h-5.5 w-12 rounded bg-surface-elevated motion-safe:animate-pulse" />
                <span className="sr-only">Reading</span>
              </span>
            ) : (
              <span data-value className="whitespace-nowrap">
                {tile.value}
              </span>
            )}
          </NumberTile>
        ))}
      </ul>
    </div>
  );
}

/**
 * One number tile, in the card language (Visual standard, rules 1 and 2): an icon and the
 * label in the Label role, then the figure at the tile figure's size. A plain figure: no link.
 */
function NumberTile({ tile, children }: { tile: Tile; children: ReactNode }): ReactElement {
  const Icon = tile.icon;
  return (
    <li data-number={tile.name}>
      <div
        title={tile.means}
        className="flex h-full flex-col gap-2 rounded-console-12 border border-border bg-surface p-3"
      >
        <span className="flex items-start gap-1.5 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {tile.label}
        </span>
        <span className="flex h-7 items-center gap-2 text-console-22 font-semibold tabular-nums text-text-primary">
          {children}
        </span>
      </div>
    </li>
  );
}
