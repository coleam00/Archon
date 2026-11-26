/**
 * One board column's header (Visual standard, rule 9; v1's `ColumnHeader.tsx`): its label, a
 * one-line subtitle, its count, and a soft chip per state its cards are in. The Merged column
 * carries its colour as a 3 px top bar. A stage column has none: on `combined` no column colour
 * is declared anywhere (v1 took it from its own column file, which the pack graph's groups
 * replace). An empty column is a compact header, so a pack's many stages keep their order on
 * screen.
 */
import type { ReactElement } from 'react';
import type { ItemRead } from '../skills/items';
import { CHIP, type Chip } from '../routes/board/standing';
import { useFactoryCards } from './cards-context';
import { askedCount, type AskRead } from './lib/item-asks';

/**
 * The header's chips, in `CHIP`'s order, each a count above 0 (rule 9): needs-you by the cards'
 * own rule (`askedCount`, which their Needs you buttons follow), null while the asks are not
 * known, and every other chip by the state each card's label shows (`read.standing.state`). A
 * running item with open asks counts under both, so the chips can add up to more than the column.
 */
export function chipsOf(
  items: readonly ItemRead[],
  asks: AskRead | null
): { needYou: number | null; states: { chip: Chip; count: number }[] } {
  const states = (Object.keys(CHIP) as Chip[]).flatMap(chip => {
    if (chip === 'needs_you') return [];
    const count = items.filter(read => read.standing.state === chip).length;
    return count === 0 ? [] : [{ chip, count }];
  });
  return { needYou: askedCount(asks, items), states };
}

const CHIP_CLASS = 'rounded-full px-2 py-0.5 text-console-12';

export function ColumnHeader({
  label,
  labelHover = label,
  subtitle,
  subtitleHover = subtitle,
  items,
  count = items.length,
  bar,
  chips = true,
}: {
  label: string;
  /** The label's hover title, where it names ids the label puts in words; else the label. */
  labelHover?: string;
  subtitle: string;
  /** The subtitle's hover title, where it names ids the subtitle puts in words; else the subtitle. */
  subtitleHover?: string;
  items: readonly ItemRead[];
  /**
   * Null while it is read: a skeleton bar stands in (rule 6). `unknown` when the read failed,
   * which the column says in words below.
   */
  count?: number | null | 'unknown';
  /** The column's colour, as a CSS value. */
  bar?: string;
  /** Whether to draw state chips; the Merged column's cards are all merged. */
  chips?: boolean;
}): ReactElement {
  const empty = count === 0;
  return (
    <header
      className={`relative flex flex-col gap-1.5 overflow-hidden rounded-console-12 border border-border bg-surface ${empty ? 'px-2 pb-1.5 pt-2' : 'px-3 pb-2 pt-3'}`}
    >
      {bar === undefined ? null : (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.75"
          style={{ background: bar }}
        />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3
            title={labelHover}
            className={`truncate text-console-15 font-semibold ${empty ? 'text-text-tertiary' : 'text-text-primary'}`}
          >
            {label}
          </h3>
          {empty ? null : (
            <p title={subtitleHover} className="truncate text-console-12 text-text-tertiary">
              {subtitle}
            </p>
          )}
        </div>
        {count === 'unknown' ? (
          <span data-count title="Could not be read" className="text-console-22 text-text-tertiary">
            ?
          </span>
        ) : count === null ? (
          <span data-count title="Reading" className="flex h-7 items-center">
            <span className="inline-block h-5.5 w-12 rounded bg-surface-elevated motion-safe:animate-pulse" />
            <span className="sr-only">Reading</span>
          </span>
        ) : (
          <span
            data-count
            className={`font-semibold tabular-nums ${empty ? 'text-console-15 text-text-tertiary' : 'text-console-22 text-text-primary'}`}
          >
            {count}
          </span>
        )}
      </div>
      {!chips || empty ? null : <HeaderChips label={label} items={items} />}
    </header>
  );
}

/**
 * The header's chip row. With no provider (a pack board drawn alone) no asks are given, so no
 * needs-you chip and no skeleton; while they are read a skeleton stands in for its count (rule
 * 6); when they could not be read the cards show no button and the header no chip, and the
 * board says why once, above its columns (`AsksUnread`).
 */
function HeaderChips({
  label,
  items,
}: {
  label: string;
  items: readonly ItemRead[];
}): ReactElement {
  const asks = useFactoryCards()?.itemAsks ?? null;
  const { needYou, states } = chipsOf(items, asks);
  const chipped: { chip: Chip; count: number }[] =
    needYou === null || needYou === 0 ? states : [{ chip: 'needs_you', count: needYou }, ...states];
  return (
    <ul aria-label={`${label} by state`} className="flex flex-wrap gap-1">
      {asks === 'reading' ? (
        <li data-chip-reading title="Reading" className="flex">
          <span className="inline-block h-5 w-16 rounded-full bg-surface-elevated motion-safe:animate-pulse" />
          <span className="sr-only">Reading</span>
        </li>
      ) : null}
      {chipped.map(({ chip, count: n }) => (
        <li key={chip} data-header-chip={chip} className={`${CHIP_CLASS} ${CHIP[chip].tone}`}>
          {CHIP[chip].label.toLowerCase()} {n}
        </li>
      ))}
    </ul>
  );
}
