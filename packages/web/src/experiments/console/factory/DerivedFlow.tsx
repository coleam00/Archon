/**
 * The map derived from the pack graph (DESIGN.md, COMBINED direction), drawn as a graph: the
 * groups left to right (the pack document's, `groupsOf`), a card per flow stage in each, under its group's name, the hand-offs between
 * them as arrows and the send-backs, each pill worded as on the curated map (`arrowWords`). On
 * a project's Overview each card carries the project's counts and opens its board; on How it
 * works, which is the pack's page and names no project (DESIGN.md, owner change 1 of
 * 2026-11-23), the cards are the structure alone. Both draw it when the pack ships no curated view file, and as the curated
 * map's "Full workflow". It wears the curated map's cards, lines, legend and camera.
 */
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { columnsOf, type BoardColumn, type StageGroup } from '../routes/BoardPage';
import { stageAt, type Retired } from '../routes/board/standing';
import type { ItemRead, PackGraph } from '../skills/items';
import {
  BACK,
  BACK_DASH,
  BACK_OPACITY,
  HeadMarker,
  LINE_TO,
  LinePill,
  MAIN_STROKE,
  STROKE,
} from './canvas-lines';
import { GraphSkeleton } from './GraphSkeleton';
import { MERGED_DAYS, type BoardNumbers } from './lib/board-numbers';
import type { FactoryWords } from './lib/graph-view';
import { fullWorkflowLayout, MERGED, type FullLayout } from './lib/full-workflow-layout';
import { toneOfKind, type ColumnTone } from './lib/map-columns';
import { MapLegend } from './map/MapLegend';
import { LIVE_FITTING, useMapCamera, type Fitting } from './map/useMapCamera';
import { usePackGraph } from './map-structure';
import { ReadFailure } from './ReadFailure';
import { cardTone, TONES, type Tone } from './tones';
import { groupsOf } from './lib/view-groups';
import { stageLabel } from './lib/stage-words';
import { arrowLabels } from './lib/curated-view';
import { askedCount, askedOf, type AskRead } from './lib/item-asks';

/**
 * How many items sit somewhere, and how many of those have open asks by the board cards' rule
 * (`lib/item-asks.ts`); null while the asks are not known.
 */
interface StageAt {
  count: number;
  needYou: number | null;
}

/** How many of a pack's items sit in each column, and how many of those have open asks. */
export function flowCounts<C extends StageGroup>(
  columns: readonly C[],
  items: readonly ItemRead[],
  stages: PackGraph['stages'] | undefined,
  asks: AskRead | null,
  /** The retired workflows the pack's stages replace, which place their runs' items (`stageAt`). */
  retired: readonly Retired[] = []
): (C & StageAt)[] {
  return columns.map(column => {
    const here = items.filter(read => column.stages.includes(stageAt(read, stages, retired) ?? ''));
    return { ...column, count: here.length, needYou: askedCount(asks, here) };
  });
}

/** How many items sit at each stage (by workflow), and how many of those have open asks. */
export function stageCounts(
  items: readonly ItemRead[],
  stages: PackGraph['stages'] | undefined,
  asks: AskRead | null,
  retired: readonly Retired[] = []
): Map<string, StageAt> {
  const counts = new Map<string, StageAt>();
  for (const read of items) {
    const at = stageAt(read, stages, retired);
    if (at === undefined) continue;
    const asked = askedOf(asks, read);
    const entry = counts.get(at) ?? { count: 0, needYou: asked === null ? null : 0 };
    entry.count += 1;
    if (asked === true && entry.needYou !== null) entry.needYou += 1;
    counts.set(at, entry);
  }
  return counts;
}

/** One column of the derived map, with the project's counts when it is drawn for one. */
type FlowColumn = BoardColumn & Partial<StageAt>;

/** What a project's derived map adds to the structure: its board and its numbers (`packBoard`). */
interface FlowLive {
  board: string;
  /** Undefined while every item is read. */
  numbers: BoardNumbers | undefined;
  /** The every-item read failed: the number tiles say so, and the Merged box shows no count. */
  failed: boolean;
}

const CARD =
  'factory-card relative flex size-full flex-col gap-1.5 overflow-hidden rounded-console-12 border px-3 pb-3 pt-4';
const CONTROL =
  'rounded px-2 py-0.5 text-console-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary';
/**
 * The whole graph fits its frame, down to a scale a card still reads at. The frame is at most
 * 80% of the window tall, so the graph opens fitted to both its width and its height rather
 * than in a frame grown taller than the window.
 */
const FULL_FITTING: Fitting = { ...LIVE_FITTING, minK: 0.4, maxFrameVh: 0.8 };
const COUNT = 'text-console-13 tabular-nums text-text-primary';

/**
 * The pack's whole workflow as a graph, from its graph and `flow`'s groups: a card per flow
 * stage in a column per group, coloured by the group's kind, the hand-offs between them as
 * arrows, and the send-backs (an arrow into the same or an earlier column) in the lanes under,
 * each pill worded as on the curated map (`arrowWords`). It pans and zooms like the curated map. With `live` (a
 * project's Overview) each card shows its count and who it waits on and opens that group on the
 * board; without it (How it works) it is the structure alone and links nowhere.
 */
export function DerivedFlow({
  flow,
  live,
  graph,
  counts,
  view = null,
}: {
  flow: readonly FlowColumn[];
  /**
   * The pack's view, whose labels name its stages (`stageLabel`) and word its pills as the
   * curated map does (`arrowLabels`); null names stages and outcomes
   * by id in words, and an ask's pill by its raw option.
   */
  view?: FactoryWords | null;
  live?: FlowLive;
  graph: PackGraph | undefined;
  counts?: ReadonlyMap<string, StageAt>;
}): ReactElement {
  const labels = useMemo(() => arrowLabels(view), [view]);
  const layout = useMemo(
    () => (graph === undefined ? undefined : fullWorkflowLayout(graph, flow, labels)),
    [graph, flow, labels]
  );
  const camera = useMapCamera(layout?.bounds ?? { x: 0, y: 0, w: 1, h: 1 }, null, FULL_FITTING);
  if (graph === undefined || layout === undefined)
    return <GraphSkeleton label="Loading the flow" />;
  const { k, x, y } = camera.camera;
  const last = layout.columns.length - 1;
  const toneOf = (column: number): ColumnTone =>
    column === last ? 'merged' : toneOfKind(flow[column]?.kind);
  const hrefOf = (column: number): string | undefined => {
    if (live === undefined) return undefined;
    if (column === last) return live.board;
    return `${live.board}?group=${encodeURIComponent(layout.columns[column]?.name ?? '')}`;
  };
  // A card's eyebrow names its group. A lone stage's column is named by its id, which is a key,
  // not words, so its card shows its tone's kind instead.
  const groupOf = (column: number): string | undefined => {
    if (column === last) return 'Merged';
    const at = flow[column];
    return at?.grouped === true ? at.heading : undefined;
  };
  const stageOf = (workflow: string): PackGraph['stages'][number] | undefined =>
    graph.stages.find(stage => stage.workflow === workflow);
  return (
    <div data-flow className="flex flex-col gap-2">
      <div
        ref={camera.frameRef}
        style={{ height: camera.height }}
        aria-label="The whole workflow. Drag to move, scroll to zoom."
        role="group"
        className="relative min-w-0 cursor-grab touch-none select-none overflow-hidden rounded-console-12 border border-border factory-canvas active:cursor-grabbing"
        {...camera.frameHandlers}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${x.toString()}px, ${y.toString()}px) scale(${k.toString()})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width={layout.bounds.w}
            height={layout.bounds.h}
          >
            <defs>
              <HeadMarker id="fw-head" colour={LINE_TO} />
              <HeadMarker id="fw-back" colour={BACK} />
            </defs>
            {layout.arrows.map(arrow => (
              <path
                key={`${arrow.from}>${arrow.to}`}
                data-arrow={`${arrow.from}>${arrow.to}`}
                d={arrow.d}
                fill="none"
                stroke={arrow.back ? BACK : LINE_TO}
                strokeWidth={arrow.back ? STROKE : MAIN_STROKE}
                strokeDasharray={arrow.back ? BACK_DASH : undefined}
                strokeOpacity={arrow.back ? BACK_OPACITY : 1}
                markerEnd={`url(#${arrow.back ? 'fw-back' : 'fw-head'})`}
              />
            ))}
            {layout.arrows.map(arrow => (
              <LinePill
                key={`${arrow.from}>${arrow.to}`}
                pill={arrow.pillBox}
                lines={arrow.lines}
              />
            ))}
          </svg>
          {layout.columns.map((column, index) => {
            const tone = TONES[toneOf(index)];
            const here = flow.find(entry => entry.name === column.name);
            const number = index === last ? live?.numbers?.mergedRecent : here?.count;
            const heading = (
              <>
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 shrink-0 rounded-sm"
                  style={{ background: tone.color }}
                />
                <span
                  data-flow-heading
                  className="truncate text-console-12 font-medium uppercase tracking-console-label text-text-secondary"
                >
                  {index === last ? 'Merged' : here?.heading}
                </span>
                {number === undefined ? null : (
                  <span data-count className={COUNT}>
                    {number}
                  </span>
                )}
              </>
            );
            const box = {
              'data-flow-group': index === last ? 'merged' : column.name,
              className: 'absolute flex h-6 items-center gap-2 border-b border-border pb-1',
              style: { left: column.box.x, top: column.box.y, width: column.box.w },
            };
            const href = hrefOf(index);
            return href === undefined ? (
              <div key={column.name} {...box}>
                {heading}
              </div>
            ) : (
              <Link key={column.name} to={href} draggable={false} {...box}>
                {heading}
              </Link>
            );
          })}
          {layout.cards.map(card => (
            <FlowCard
              key={card.id}
              card={card}
              tone={TONES[toneOf(card.column)]}
              group={groupOf(card.column)}
              stage={stageOf(card.id)}
              name={stageLabel(view, card.id)}
              at={counts?.get(card.id)}
              live={live}
              href={hrefOf(card.column)}
            />
          ))}
        </div>
        <div
          onPointerDown={event => event.stopPropagation()}
          className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-console-12 border border-border bg-surface px-1 py-0.5"
        >
          <button type="button" aria-label="Zoom out" onClick={camera.zoomOut} className={CONTROL}>
            −
          </button>
          <button type="button" onClick={camera.fit} className={CONTROL}>
            Fit
          </button>
          <button type="button" aria-label="Zoom in" onClick={camera.zoomIn} className={CONTROL}>
            +
          </button>
        </div>
      </div>
      <MapLegend tones={layout.columns.map((_, index) => toneOf(index))} map="full" />
    </div>
  );
}

/** The Merged card's line: what it means, or on an Overview the board's recent merges. */
function MergedLine({ live }: { live: FlowLive | undefined }): ReactElement {
  if (live === undefined) return <span>The change landed</span>;
  const today = live.numbers === undefined ? '' : ` · ${String(live.numbers.mergedToday)} today`;
  return <span>{`last ${String(MERGED_DAYS)} days${today}`}</span>;
}

/** A stage card's line: its steps, whether it asks or waits, and the project's counts. */
function StageLine({
  stage,
  at,
}: {
  stage: PackGraph['stages'][number] | undefined;
  at: StageAt | undefined;
}): ReactElement {
  return (
    <>
      <span className="truncate">
        {stage === undefined ? '' : `${String(stage.nodes.length)} steps`}
        {stage?.asks === true ? ' · asks' : ''}
        {stage?.waits === true ? ' · waits' : ''}
      </span>
      {at === undefined ? null : (
        <span
          data-stage-count
          className="ml-auto inline-flex h-5 shrink-0 items-center rounded-full bg-[color:var(--running-soft)] px-2 tabular-nums text-[color:var(--running)]"
        >
          {at.count} here
        </span>
      )}
      {/* Drawn once the asks are known, and only above 0 (rule 9). */}
      {at === undefined || at.needYou === null || at.needYou === 0 ? null : (
        <span
          data-need-you
          className="inline-flex h-5 shrink-0 items-center rounded-full bg-[color:var(--warning-soft)] px-2 tabular-nums text-warning"
        >
          {at.needYou} need you
        </span>
      )}
    </>
  );
}

/**
 * One card of the derived map: a flow stage under its group's name (the tone's kind only for a
 * card in no group), or the Merged card. With `href` it opens the board there.
 */
function FlowCard({
  card,
  tone,
  group,
  stage,
  name,
  at,
  live,
  href,
}: {
  card: FullLayout['cards'][number];
  tone: Tone;
  group: string | undefined;
  stage: PackGraph['stages'][number] | undefined;
  /** The stage's name (`stageLabel`); the Merged card has its own. */
  name: string;
  at: StageAt | undefined;
  live: FlowLive | undefined;
  href: string | undefined;
}): ReactElement {
  const merged = card.id === MERGED;
  const body = (
    <>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ background: tone.color }}
      />
      <span className="flex h-4 items-center gap-1.5">
        <tone.Icon aria-hidden="true" className="size-4 shrink-0" style={{ color: tone.color }} />
        <span className="truncate text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
          {group ?? tone.kind}
        </span>
      </span>
      <span className="line-clamp-2 text-console-15 font-semibold leading-5 text-text-primary">
        {merged ? 'Merged' : name}
      </span>
      <span className="mt-auto flex items-center gap-1.5 overflow-hidden text-console-12 text-text-tertiary">
        {merged ? <MergedLine live={live} /> : <StageLine stage={stage} at={at} />}
      </span>
    </>
  );
  return (
    <div
      data-flow-stage={card.id}
      className="absolute"
      style={{ left: card.box.x, top: card.box.y, width: card.box.w, height: card.box.h }}
    >
      {href === undefined ? (
        <div className={CARD} data-static="" style={cardTone(tone.color)}>
          {body}
        </div>
      ) : (
        <Link
          to={href}
          draggable={false}
          className={CARD}
          data-lit={at === undefined || at.count === 0 ? undefined : ''}
          style={cardTone(tone.color)}
        >
          {body}
        </Link>
      )}
    </div>
  );
}

/**
 * The pack's derived map as structure only, from its graph: How it works, the pack's page,
 * draws it with no project's counts or board. The graph is read through the first project that
 * stages the pack, as the server reads a pack as a project has it installed.
 */
export function DerivedStructure({
  projectId,
  pack,
  view,
}: {
  projectId: string;
  pack: string;
  /** The pack's view, when it has one: its groups are the columns, as on the curated map. */
  view?: FactoryWords;
}): ReactElement {
  const graph = usePackGraph(projectId, pack);
  if (graph.data === undefined)
    return graph.error === undefined ? (
      <GraphSkeleton label="Loading the flow" />
    ) : (
      <ReadFailure retry={graph.refetch}>
        The pack's graph could not be read: {graph.error.message}
      </ReadFailure>
    );
  return (
    <DerivedFlow
      flow={columnsOf(graph.data, groupsOf(graph.data), view ?? null)}
      graph={graph.data}
      view={view ?? null}
    />
  );
}
