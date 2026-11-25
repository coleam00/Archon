/**
 * The map's columns in their colours. A column is a document group of the pack, or one card
 * (`curated-view.ts`). The pack names no colours: the columns take the console's stage colours
 * in order (taking work in, building, checking, merging), the column the board's Done is
 * counted on takes the merged colour, and a column past the fourth is `other`.
 */
import type { CuratedColumn, CuratedView } from './curated-view';

const STAGE_TONES = ['intake', 'build', 'check', 'land'] as const;
/** A column's colour: a stage colour by position, the merged column's own, or `other`. */
export type ColumnTone = (typeof STAGE_TONES)[number] | 'merged' | 'other';

export interface MapColumn extends CuratedColumn {
  tone: ColumnTone;
}

export function mapColumns(view: Pick<CuratedView, 'columns' | 'landed'>): MapColumn[] {
  let position = 0;
  return view.columns.map(column => {
    if (column.stages.includes(view.landed.stage)) return { ...column, tone: 'merged' };
    const tone = STAGE_TONES[position] ?? 'other';
    position += 1;
    return { ...column, tone };
  });
}
