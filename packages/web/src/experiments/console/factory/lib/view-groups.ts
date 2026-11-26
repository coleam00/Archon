/**
 * The groups a factory map draws (DESIGN.md, COMBINED direction): the view file's own groups
 * when it declares any, else the pack document's groups the graph serves, else none (a column
 * per stage). The file's win where both exist, so one file draws the same map on a pack that
 * has document groups and on one that does not. A stage's card heading comes from its group,
 * never from the column it happens to land in. Pure.
 */
import type { PackGraph } from '../../skills/items';
import type { FactoryView } from '../api';

/** Which of the console's group colours and kind labels a group takes (`map-columns.ts`). */
export type GroupKind = NonNullable<NonNullable<FactoryView['groups']>[number]['kind']>;

export interface ViewGroup {
  name: string;
  /** The file's line for the group; a document group has none. */
  blurb?: string;
  /** Its stages by `workflow` name, in flow order. */
  stages: string[];
  /** The file's kind for the group; a document group has none, so it reads neutral. */
  kind?: GroupKind;
}

export function groupsOf(
  view: Pick<FactoryView, 'groups'> | null | undefined,
  graph: Pick<PackGraph, 'groups'> | undefined
): ViewGroup[] {
  const declared = view?.groups ?? [];
  if (declared.length > 0)
    return declared.map(group => ({
      name: group.name,
      blurb: group.blurb,
      stages: [...group.stages],
      ...(group.kind === undefined ? {} : { kind: group.kind }),
    }));
  return (graph?.groups ?? []).map(group => ({ name: group.name, stages: [...group.stages] }));
}
