import type { ReactElement, ReactNode } from 'react';

/**
 * The Visual standard's loading shapes (rule 6): a block at the final card's size, a 12 px text
 * line at 60% or 40% width, and a number tile's 22 by 48 px figure. Every shape pulses and is
 * hidden from a screen reader; a `SkeletonGroup` around them says what is loading instead.
 */

const PULSE = 'bg-surface-elevated motion-safe:animate-pulse';

/** A text line still loading. */
export function SkeletonLine({ width = 'long' }: { width?: 'long' | 'short' }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-skeleton="line"
      className={`block h-3 rounded ${width === 'long' ? 'w-3/5' : 'w-2/5'} ${PULSE}`}
    />
  );
}

/** A number not known yet: the number tile figure's size (rule 6). */
export function SkeletonFigure(): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-skeleton="figure"
      className={`inline-block h-5.5 w-12 rounded align-middle ${PULSE}`}
    />
  );
}

/** A card or panel still loading, at the final one's height (a Tailwind `h-*` class). */
export function SkeletonBlock({
  height,
  rounded = 'rounded-console-12',
  children,
}: {
  height: string;
  /** A card is `rounded-console-12`; an ask card `rounded-console-16`. */
  rounded?: 'rounded-console-12' | 'rounded-console-16';
  /** Line shapes drawn inside the block, as a card's rows. */
  children?: ReactNode;
}): ReactElement {
  return (
    <div
      aria-hidden="true"
      data-skeleton="block"
      className={`flex w-full shrink-0 flex-col gap-2 p-3 ${height} ${rounded} ${PULSE}`}
    >
      {children}
    </div>
  );
}

/** Lines drawn inside a `SkeletonBlock`: a shade apart from the block they sit on. */
export function SkeletonInnerLine({ width = 'long' }: { width?: 'long' | 'short' }): ReactElement {
  return (
    <span
      className={`block h-3 rounded bg-surface-hover ${width === 'long' ? 'w-3/5' : 'w-2/5'}`}
    />
  );
}

/** Skeleton shapes with what they stand for, once, for a screen reader. */
export function SkeletonGroup({
  label,
  className = 'flex flex-col gap-3',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div role="status" data-skeleton="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
