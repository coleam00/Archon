import type { ReactElement } from 'react';
import type { CuratedView, FactoryDrilldown } from '../lib/curated-view';
import { DrilldownCard } from './DrilldownCard';

/** A phase column's widest, so a one-phase stage does not stretch a card across the page. */
export const PHASE_COLUMN_REM = 20;
/** The gap between phase columns. */
export const PHASE_GAP_REM = 1;

/*
 * Laid out in CSS, not on a canvas: at most a handful of phases fit the page at full size,
 * which a projected screen needs. From `md` up the phases are equal grid columns (each at most
 * `PHASE_COLUMN_REM`); below `md` they stack. The stage modal is as wide as these columns.
 */

/**
 * A stage told as its drill-down: numbered phases of plain cards, left to right. A card is
 * plain text: there is no step page.
 */
export function StageDrilldown({
  view,
  drilldown,
}: {
  view: CuratedView;
  drilldown: FactoryDrilldown;
}): ReactElement {
  const { phases } = drilldown;
  return (
    <div
      className="flex flex-col md:grid md:items-start"
      style={{
        gap: `${String(PHASE_GAP_REM)}rem`,
        gridTemplateColumns: `repeat(${String(phases.length)}, minmax(0, ${String(PHASE_COLUMN_REM)}rem))`,
      }}
    >
      {phases.map((phase, index) => (
        <section
          // Phase labels may repeat across a card's stages; a phase's position is its identity.
          key={index}
          data-phase={index + 1}
          aria-label={`Phase ${String(index + 1)}: ${phase.label}`}
          className="flex min-w-0 flex-col gap-3"
        >
          <h4 className="flex items-center gap-2.5">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-surface-elevated text-console-13 font-semibold text-text-primary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              {index + 1}
            </span>
            <span className="text-console-15 font-semibold text-text-primary">{phase.label}</span>
          </h4>
          {phase.cards.map((card, c) => (
            // Titles may repeat within a phase; a card's position is its identity here.
            <DrilldownCard key={c} view={view} card={card} />
          ))}
        </section>
      ))}
    </div>
  );
}
