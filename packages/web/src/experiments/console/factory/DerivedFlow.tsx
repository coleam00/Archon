/**
 * The map derived from the pack graph (DESIGN.md, COMBINED direction): the pack's columns, its
 * document groups then each flow stage no group holds, as a row of boxes, then Merged. On a
 * project's Overview each box carries the project's counts and opens its board; on How it works,
 * which is the pack's page and names no project (DESIGN.md, owner change 1 of 2026-11-23), the
 * boxes are the structure alone. Both draw it when the pack ships no curated view file, and as
 * the curated map's "Full workflow".
 */
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { chipOf, columnsOf, type StageGroup } from '../routes/BoardPage';
import { stageAt } from '../routes/board/standing';
import type { ItemRead, PackGraph } from '../skills/items';
import { MERGED_DAYS, type BoardNumbers } from './lib/board-numbers';
import { GraphSkeleton } from './GraphSkeleton';
import { usePackGraph } from './map-structure';
import { ReadFailure } from './ReadFailure';

/** How many of a pack's items sit in each column, and how many of those wait on the operator. */
export function flowCounts(
  columns: readonly StageGroup[],
  items: readonly ItemRead[],
  stages: PackGraph['stages'] | undefined
): { name: string; stages: string[]; count: number; needYou: number }[] {
  return columns.map(column => {
    const here = items.filter(read => column.stages.includes(stageAt(read, stages) ?? ''));
    return {
      ...column,
      count: here.length,
      needYou: here.filter(read => chipOf(read) === 'needs_you').length,
    };
  });
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

const BOX = 'block min-w-36 rounded-console-12 border border-border px-4 py-3';

/**
 * The pack's columns as a row of boxes, then Merged. With `live` (a project's Overview), each
 * box shows its count and who it waits on and opens that column on the board; without it
 * (How it works), the boxes show the structure alone and link nowhere.
 */
export function DerivedFlow({
  flow,
  live,
}: {
  flow: readonly FlowColumn[];
  live?: FlowLive;
}): ReactElement {
  const box = (name: string, to: string | undefined, children: ReactNode): ReactElement =>
    to === undefined ? (
      <div data-flow-group={name} className={BOX}>
        {children}
      </div>
    ) : (
      <Link data-flow-group={name} to={to} className={`${BOX} hover:border-border-bright`}>
        {children}
      </Link>
    );
  return (
    <div data-flow>
      <h2 className="text-sm font-medium text-text-primary">The flow</h2>
      <ol className="mt-3 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch">
        {flow.map(column => (
          <li key={column.name} className="flex items-center gap-2">
            {box(
              column.name,
              live === undefined
                ? undefined
                : `${live.board}?group=${encodeURIComponent(column.name)}`,
              <>
                <span className="text-console-12 font-medium text-text-secondary">
                  {column.name}
                </span>
                {column.count === undefined ? null : (
                  <span data-count className="ml-2 text-base tabular-nums text-text-primary">
                    {column.count}
                  </span>
                )}
                <span className="mt-1 block font-mono text-console-10 text-text-tertiary">
                  {column.stages.join(' · ')}
                </span>
                {column.needYou === undefined || column.needYou === 0 ? null : (
                  <span data-need-you className="mt-1 block text-console-11 text-warning">
                    {column.needYou} need you
                  </span>
                )}
              </>
            )}
            <span aria-hidden className="text-text-tertiary">
              →
            </span>
          </li>
        ))}
        <li>
          {box(
            'merged',
            live?.board,
            <>
              <span className="text-console-12 font-medium text-text-secondary">Merged</span>
              {live === undefined ? null : live.numbers === undefined ? (
                live.failed ? null : (
                  <span className="ml-2 inline-block h-3 w-6 rounded bg-surface-elevated motion-safe:animate-pulse" />
                )
              ) : (
                <span data-count className="ml-2 text-base tabular-nums text-text-primary">
                  {live.numbers.mergedRecent}
                </span>
              )}
              {live === undefined ? null : (
                <span className="mt-1 block text-console-12 text-text-tertiary">
                  last {MERGED_DAYS} days
                  {live.numbers === undefined ? '' : ` · ${String(live.numbers.mergedToday)} today`}
                </span>
              )}
            </>
          )}
        </li>
      </ol>
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
  return <DerivedFlow flow={columnsOf(graph.data)} />;
}
