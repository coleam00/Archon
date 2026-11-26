/**
 * The map derived from the pack graph (DESIGN.md, COMBINED direction), drawn as a graph: the
 * pack's document groups left to right, a card per flow stage in each, the hand-offs between
 * them as arrows and the send-backs labelled with their outcome. On a project's Overview each
 * card carries the project's counts and opens its board; on How it works, which is the pack's
 * page and names no project (DESIGN.md, owner change 1 of 2026-11-23), the cards are the
 * structure alone. Both draw it when the pack ships no curated view file, and as the curated
 * map's "Full workflow". It wears the curated map's cards, lines, legend and camera.
 */
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router';
import { chipOf, columnsOf, type StageGroup } from '../routes/BoardPage';
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
import { fullWorkflowLayout, MERGED } from './lib/full-workflow-layout';
import type { ColumnTone } from './lib/map-columns';
import { MapLegend } from './map/MapLegend';
import { LIVE_FITTING, useMapCamera, type Fitting } from './map/useMapCamera';
import { usePackGraph } from './map-structure';
import { ReadFailure } from './ReadFailure';
import { cardTone, TONES } from './tones';

/** How many of a pack's items sit in each column, and how many of those wait on the operator. */
export function flowCounts(
  columns: readonly StageGroup[],
  items: readonly ItemRead[],
  stages: PackGraph['stages'] | undefined,
  /** The view's retired workflows, which place their runs' items (`stageAt`). */
  retired: readonly Retired[] = []
): { name: string; stages: string[]; count: number; needYou: number }[] {
  return columns.map(column => {
    const here = items.filter(read => column.stages.includes(stageAt(read, stages, retired) ?? ''));
    return {
      ...column,
      count: here.length,
      needYou: here.filter(read => chipOf(read) === 'needs_you').length,
    };
  });
}

/** How many items sit at each stage (by workflow), and how many of those wait on the operator. */
export function stageCounts(
  items: readonly ItemRead[],
  stages: PackGraph['stages'] | undefined,
  retired: readonly Retired[] = []
): Map<string, { count: number; needYou: number }> {
  const counts = new Map<string, { count: number; needYou: number }>();
  for (const read of items) {
    const at = stageAt(read, stages, retired);
    if (at === undefined) continue;
    const entry = counts.get(at) ?? { count: 0, needYou: 0 };
    entry.count += 1;
    if (chipOf(read) === 'needs_you') entry.needYou += 1;
    counts.set(at, entry);
  }
  return counts;
}

/** One column of the derived map, with the project's counts when it is drawn for one. */
type FlowColumn = StageGroup & { count?: number; needYou?: number };

/** What a project's derived map adds to the structure: its board and its numbers (`packBoard`). */
interface FlowLive {
  board: string;
  /** Undefined while every item is read. */
  numbers: BoardNumbers | undefined;
  /** The every-item read failed: the number tiles say so, and the Merged box shows no count. */
  failed: boolean;
}

/** A stage's name as a person reads it: `build-and-test` reads "Build and test". */
export function stageWords(workflow: string): string {
  const spaced = workflow.replace(/[_-]+/g, ' ').trim();
  return spaced === '' ? workflow : spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
const STAGE_TONES: readonly ColumnTone[] = ['intake', 'build', 'check', 'land'];

/**
 * The pack's whole workflow as a graph, from its graph and its document's groups: a card per
 * flow stage in a column per group, the hand-offs between them as arrows, and the send-backs
 * (an arrow into the same or an earlier column) in the lanes under, each labelled with its
 * outcome. It pans and zooms like the curated map. With `live` (a project's Overview) each
 * card shows its count and who it waits on and opens that group on the board; without it (How
 * it works) it is the structure alone and links nowhere.
 */
export function DerivedFlow({
  flow,
  live,
  graph,
  counts,
}: {
  flow: readonly FlowColumn[];
  live?: FlowLive;
  graph: PackGraph | undefined;
  counts?: ReadonlyMap<string, { count: number; needYou: number }>;
}): ReactElement {
  const layout = useMemo(
    () => (graph === undefined ? undefined : fullWorkflowLayout(graph, columnsOf(graph))),
    [graph, flow]
  );
  const camera = useMapCamera(layout?.bounds ?? { x: 0, y: 0, w: 1, h: 1 }, null, FULL_FITTING);
  if (graph === undefined || layout === undefined)
    return <GraphSkeleton label="Loading the flow" />;
  const { k, x, y } = camera.camera;
  const last = layout.columns.length - 1;
  const toneOf = (column: number): ColumnTone =>
    column === last ? 'merged' : (STAGE_TONES[column] ?? 'other');
  const hrefOf = (column: number): string | undefined => {
    if (live === undefined) return undefined;
    if (column === last) return live.board;
    return `${live.board}?group=${encodeURIComponent(layout.columns[column]?.name ?? '')}`;
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
                <span className="truncate text-console-12 font-medium uppercase tracking-console-label text-text-secondary">
                  {column.name}
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
          {layout.cards.map(card => {
            const tone = TONES[toneOf(card.column)];
            const merged = card.id === MERGED;
            const stage = merged ? undefined : stageOf(card.id);
            const at = counts?.get(card.id);
            const column = layout.columns[card.column];
            const body = (
              <>
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-0.75"
                  style={{ background: tone.color }}
                />
                <span className="flex h-4 items-center gap-1.5">
                  <tone.Icon
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    style={{ color: tone.color }}
                  />
                  <span className="truncate text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
                    {column?.name ?? tone.kind}
                  </span>
                </span>
                <span className="line-clamp-2 text-console-15 font-semibold leading-5 text-text-primary">
                  {merged ? 'Merged' : stageWords(card.id)}
                </span>
                <span className="mt-auto flex items-center gap-1.5 overflow-hidden text-console-12 text-text-tertiary">
                  {merged ? (
                    <span>
                      {live === undefined
                        ? 'The change landed'
                        : `last ${String(MERGED_DAYS)} days${
                            live.numbers === undefined
                              ? ''
                              : ` · ${String(live.numbers.mergedToday)} today`
                          }`}
                    </span>
                  ) : (
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
                      {at === undefined || at.needYou === 0 ? null : (
                        <span
                          data-need-you
                          className="inline-flex h-5 shrink-0 items-center rounded-full bg-[color:var(--warning-soft)] px-2 tabular-nums text-warning"
                        >
                          {at.needYou} need you
                        </span>
                      )}
                    </>
                  )}
                </span>
              </>
            );
            const to = hrefOf(card.column);
            return (
              <div
                key={card.id}
                data-flow-stage={card.id}
                className="absolute"
                style={{
                  left: card.box.x,
                  top: card.box.y,
                  width: card.box.w,
                  height: card.box.h,
                }}
              >
                {to === undefined ? (
                  <div className={CARD} data-static="" style={cardTone(tone.color)}>
                    {body}
                  </div>
                ) : (
                  <Link
                    to={to}
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
          })}
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
      <MapLegend tones={layout.columns.map((_, index) => toneOf(index))} />
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
}: {
  projectId: string;
  pack: string;
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
  return <DerivedFlow flow={columnsOf(graph.data)} graph={graph.data} />;
}
