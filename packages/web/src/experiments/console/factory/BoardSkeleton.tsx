import type { ReactElement } from 'react';
import { SkeletonGroup } from '../components/Skeleton';
import { CardSkeletons } from './BoardColumn';
import { ColumnHeader } from './ColumnHeader';
import { boardModel, type FactoryDeclaration } from './lib/board';
import { MERGED_DAYS } from './lib/merged-window';

const LOADING = { title: 'Loading', word: 'loading' };

/**
 * The Pipeline before the items are read (Visual standard, rule 6): the declared columns,
 * known from the view file, on the loaded board's grid, each with its header, a skeleton
 * count and two card shapes, so the board fills in where it already stands.
 */
export function BoardSkeleton({ view }: { view: FactoryDeclaration }): ReactElement {
  const { columns, landedColumn } = boardModel(view, '', [], new Map(), new Date(0));
  return (
    <SkeletonGroup
      label="Loading the board"
      className="flex flex-col gap-3 md:min-h-80 md:flex-1 md:basis-0"
    >
      <div className="flex flex-col gap-6 md:min-h-0 md:flex-1 md:flex-row md:gap-3 md:overflow-x-auto">
        {columns.map(column => (
          <section
            key={column.id}
            aria-label={column.label}
            className="flex flex-col gap-3 md:min-h-0 md:w-0 md:min-w-52 md:flex-1"
          >
            <ColumnHeader
              id={column.id}
              label={column.label}
              subtitle={
                column.id === landedColumn ? `last ${MERGED_DAYS.toString()} days` : column.blurb
              }
              tone={column.tone}
              count={null}
              chips={[]}
              waiting={LOADING}
            />
            <CardSkeletons label={`Loading ${column.label}`} />
          </section>
        ))}
      </div>
    </SkeletonGroup>
  );
}
