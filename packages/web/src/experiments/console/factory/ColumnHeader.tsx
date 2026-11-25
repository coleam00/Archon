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
import { CHIP, chipOf, type Chip } from '../routes/board/standing';

/** A column's chips stay soft, Needs you included (rule 5: only a card's pill is filled). */
const SOFT: Partial<Record<Chip, string>> = {
  needs_you: 'bg-[color:var(--warning-soft)] text-warning',
};

/** How many of `items` are in each state, in the chips' order; states with none are left out. */
function chipsOf(items: readonly ItemRead[]): { chip: Chip; count: number }[] {
  return (Object.keys(CHIP) as Chip[]).flatMap(chip => {
    const count = items.filter(read => chipOf(read) === chip).length;
    return count === 0 ? [] : [{ chip, count }];
  });
}

export function ColumnHeader({
  label,
  subtitle,
  items,
  count = items.length,
  bar,
  chips = true,
}: {
  label: string;
  subtitle: string;
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
            title={label}
            className={`truncate text-console-15 font-semibold ${empty ? 'text-text-tertiary' : 'text-text-primary'}`}
          >
            {label}
          </h3>
          {empty ? null : (
            <p title={subtitle} className="truncate text-console-12 text-text-tertiary">
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
      {!chips || empty ? null : (
        <ul aria-label={`${label} by state`} className="flex flex-wrap gap-1">
          {chipsOf(items).map(({ chip, count: n }) => (
            <li
              key={chip}
              className={`rounded-full px-2 py-0.5 text-console-12 ${SOFT[chip] ?? CHIP[chip].tone}`}
            >
              {CHIP[chip].label.toLowerCase()} {n}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
