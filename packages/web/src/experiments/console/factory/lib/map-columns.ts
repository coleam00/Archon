/**
 * The map's columns in their colours. A column is a group, or one stage in none
 * (`curated-view.ts`). A column's colour and kind label come from its group's declared `kind`
 * (owner ruling on #237): never from where the column falls, so dropping or adding a group moves
 * no other group's colour. A group with no kind, or `neutral`, and a stage in no group, take
 * `other`; the column the board's Merged column is counted on takes the merged colour.
 */
import type { GroupKind } from './view-groups';
import type { CuratedColumn, CuratedView } from './curated-view';

/** A column's colour: its group kind's, the merged column's own, or `other`. */
export type ColumnTone = 'intake' | 'build' | 'check' | 'land' | 'merged' | 'other';

const KIND_TONES: Record<GroupKind, ColumnTone> = {
  intake: 'intake',
  build: 'build',
  check: 'check',
  merge: 'land',
  neutral: 'other',
};

/** The colour a group of `kind` takes; a group or stage with none is `other`. */
export const toneOfKind = (kind: GroupKind | undefined): ColumnTone =>
  kind === undefined ? 'other' : KIND_TONES[kind];

export interface MapColumn extends CuratedColumn {
  tone: ColumnTone;
}

export function mapColumns(view: Pick<CuratedView, 'columns' | 'landed'>): MapColumn[] {
  return view.columns.map(column => ({
    ...column,
    tone: column.stages.includes(view.landed.stage) ? 'merged' : toneOfKind(column.kind),
  }));
}
