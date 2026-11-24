/**
 * The board's columns, from the declaration: its `columns` (each a group of stages), else one
 * column per stage, so a view file written before `columns` still draws its board. The schema
 * guarantees each declared stage sits in exactly one declared column.
 */
import type { FactoryDeclaration } from './board';

type Group = FactoryDeclaration['stages'][number]['group'];
/** A column's colour: a stage group's, or the merged column's own. */
export type ColumnTone = Group | 'merged';

export interface BoardColumnDecl {
  id: string;
  label: string;
  /** The header's one-line subtitle. */
  blurb: string;
  /** The stages it holds, in declaration order of the column. */
  stages: string[];
  tone: ColumnTone;
}

/**
 * A column takes the colour of its last stage's group, the stage an item leaves it from, so
 * "Plan & build" reads as build; the column holding the landed stage takes the merged colour.
 */
function toneOf(view: FactoryDeclaration, stages: readonly string[]): ColumnTone {
  if (stages.includes(view.landed.stage)) return 'merged';
  const last = stages.at(-1);
  // The schema rejects a column naming an undeclared stage, so the find always succeeds.
  return view.stages.find(stage => stage.id === last)?.group ?? 'intake';
}

export function boardColumns(view: FactoryDeclaration): BoardColumnDecl[] {
  const declared =
    view.columns ??
    view.stages.map(stage => ({
      id: stage.id,
      label: stage.label,
      blurb: stage.blurb,
      stages: [stage.id],
    }));
  return declared.map(column => ({ ...column, tone: toneOf(view, column.stages) }));
}
