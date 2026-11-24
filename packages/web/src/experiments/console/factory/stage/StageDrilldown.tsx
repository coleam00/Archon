import { RotateCcw } from 'lucide-react';
import { useMemo, type ReactElement } from 'react';
import type { FactoryItem } from '../../skills/factory';
import { displayKeyOf } from '../lib/work-orders';
import type { EntityView } from '../../store/cache';
import { drilldownLive, type DrilldownLive, type FactoryDrilldown } from '../lib/drilldown-live';
import type { ItemOnStep } from '../lib/items-on-step';
import type { FactoryStage } from '../lib/stage-steps';
import type { FactoryViewListed } from '../lib/views';
import { cardShadows, recentTally } from '../lib/shadows';
import { RUNNING_GLOW } from '../StepGraph';
import { DrilldownCard } from './DrilldownCard';

type Declaration = FactoryViewListed['declaration'];

const NOTHING: readonly ItemOnStep[] = [];
const NO_ITEMS: readonly FactoryItem[] = [];

/** A phase column's widest, so a one-phase stage does not stretch a card across the page. */
export const PHASE_COLUMN_REM = 20;
/** The gap between phase columns. */
export const PHASE_GAP_REM = 1;

/*
 * Laid out in CSS, not on a canvas: at most a handful of phases fit the page at full size,
 * which a projected screen needs. From `md` up the phases are equal grid columns (each at most
 * `PHASE_COLUMN_REM`), and the loop frame is a subgrid spanning its phases, so they keep the
 * same columns as the rest. Below `md` they stack. The stage modal is as wide as these columns.
 */

/**
 * A stage told as its drill-down: numbered phases of plain cards, left to right, with the
 * loop drawn as one labelled frame around the phases it repeats. A card glows and names the
 * items on a step it covers now; clicking it opens the step page of the step it stands for.
 */
export function StageDrilldown({
  projectId,
  view,
  stage,
  drilldown,
  items,
}: {
  projectId: string;
  view: Declaration;
  stage: FactoryStage;
  drilldown: FactoryDrilldown;
  items: EntityView<FactoryItem[]>;
}): ReactElement {
  // A failed refresh keeps the last list in the cache; it is no longer evidence of what runs.
  const live = useMemo(
    () =>
      items.error === undefined && items.data !== undefined
        ? drilldownLive(drilldown, items.data)
        : undefined,
    [drilldown, items.data, items.error]
  );
  const phase = (p: number, besideLoop = false): ReactElement => (
    <Phase
      key={p}
      index={p}
      view={view}
      projectId={projectId}
      stageId={stage.id}
      drilldown={drilldown}
      live={live}
      items={items.data ?? NO_ITEMS}
      besideLoop={besideLoop}
    />
  );
  const { loop, phases } = drilldown;
  const all = phases.map((_, p) => p);
  return (
    <div
      className={`flex flex-col md:grid md:items-start ${loop === undefined ? '' : 'pb-4'}`}
      style={{
        gap: `${String(PHASE_GAP_REM)}rem`,
        gridTemplateColumns: `repeat(${String(phases.length)}, minmax(0, ${String(PHASE_COLUMN_REM)}rem))`,
      }}
    >
      {loop === undefined ? (
        all.map(p => phase(p))
      ) : (
        <>
          {all.slice(0, loop.from - 1).map(p => phase(p, true))}
          <LoopFrame loop={loop} onLoop={live?.loop ?? NOTHING}>
            {all.slice(loop.from - 1, loop.to).map(p => phase(p))}
          </LoopFrame>
          {all.slice(loop.to).map(p => phase(p, true))}
        </>
      )}
    </div>
  );
}

/** One numbered phase: its header, then its cards stacked. */
function Phase({
  index,
  view,
  projectId,
  stageId,
  drilldown,
  live,
  items,
  besideLoop,
}: {
  index: number;
  view: Declaration;
  projectId: string;
  stageId: string;
  drilldown: FactoryDrilldown;
  live: DrilldownLive | undefined;
  /** Every item read, for what a shadow step decided lately; empty before the first read. */
  items: readonly FactoryItem[];
  /**
   * Beside a loop frame: in its own column of the row, its header padded level with the
   * framed phases' headers, which sit inside the frame's border and padding.
   */
  besideLoop: boolean;
}): ReactElement | null {
  const phase = drilldown.phases[index];
  if (phase === undefined) return null;
  return (
    <section
      data-phase={index + 1}
      aria-label={`Phase ${String(index + 1)}: ${phase.label}`}
      className={`flex min-w-0 flex-col gap-3 ${besideLoop ? 'md:pt-3.5' : ''}`}
      style={besideLoop ? { gridColumn: String(index + 1), gridRow: '1' } : undefined}
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
        <DrilldownCard
          // Titles may repeat within a phase; a card's position is its identity here.
          key={c}
          view={view}
          projectId={projectId}
          stageId={stageId}
          card={card}
          onCard={live?.cards[index]?.[c] ?? NOTHING}
          shadow={shadowOfCard(card, view, items)}
        />
      ))}
    </section>
  );
}

/** A card's shadow marking and its recent decisions; null when it covers no shadow step. */
function shadowOfCard(
  card: FactoryDrilldown['phases'][number]['cards'][number],
  view: Declaration,
  items: readonly FactoryItem[]
): { lately: string[] } | null {
  const shadows = cardShadows(card, view);
  if (shadows.length === 0) return null;
  return {
    lately: shadows.flatMap(shadow => {
      const tally = recentTally(items, [shadow]);
      return tally === null ? [] : [tally];
    }),
  };
}

/**
 * The loop: one rounded line around the phases it repeats, its label on the bottom edge. It is
 * a border, so nothing it draws can cross. The label glows while a run sits between rounds.
 */
function LoopFrame({
  loop,
  onLoop,
  children,
}: {
  loop: NonNullable<FactoryDrilldown['loop']>;
  onLoop: readonly ItemOnStep[];
  children: ReactElement[];
}): ReactElement {
  const glows = onLoop.length > 0;
  return (
    <div
      data-loop={loop.label}
      className="relative flex flex-col gap-4 rounded-console-16 border-2 p-3 pb-7 md:grid"
      style={{
        borderColor: 'color-mix(in oklch, var(--node-loop), transparent 30%)',
        gridColumn: `${String(loop.from)} / ${String(loop.to + 1)}`,
        gridRow: '1',
        gridTemplateColumns: 'subgrid',
      }}
    >
      {children}
      <span
        data-live={glows ? 'true' : undefined}
        title={
          glows
            ? `Between rounds: ${onLoop.map(({ item }) => displayKeyOf(item)).join(', ')}`
            : undefined
        }
        className="absolute bottom-0 left-1/2 inline-flex -translate-x-1/2 translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border-2 bg-surface px-3 py-1 text-console-13 font-semibold text-text-primary"
        style={{
          borderColor: 'color-mix(in oklch, var(--node-loop), transparent 30%)',
          // The glow's ring and border only: the label keeps its solid backing over the line.
          ...(glows
            ? { borderColor: RUNNING_GLOW.borderColor, boxShadow: RUNNING_GLOW.boxShadow }
            : {}),
        }}
      >
        <RotateCcw aria-hidden="true" className="size-4" style={{ color: 'var(--node-loop)' }} />
        {loop.label}
      </span>
    </div>
  );
}
