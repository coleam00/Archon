/**
 * The groups a factory map draws (DESIGN.md, COMBINED direction: "No hand-synced view file"):
 * the pack document's groups, as the graph serves them, else none (a column per stage). The
 * engine has already dropped a stale stage from its group and lists why in
 * `graph.document.problems`. A stage's card heading comes from its group, never from the
 * column it happens to land in. Pure.
 */
import type { PackGraph } from '../../skills/items';

/**
 * The group kinds this console draws, each with its colour and kind label (`map-columns.ts`).
 * The engine serves a group's `kind` as an opaque slug; any other reads neutral.
 */
const GROUP_KINDS = ['intake', 'build', 'check', 'merge'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

const isGroupKind = (kind: string): kind is GroupKind =>
  (GROUP_KINDS as readonly string[]).includes(kind);

export interface ViewGroup {
  name: string;
  /** The document's line for the group. */
  blurb?: string;
  /** Its stages by `workflow` name, in flow order. */
  stages: string[];
  /** Its kind when this console draws it; none reads neutral. */
  kind?: GroupKind;
}

export function groupsOf(graph: Pick<PackGraph, 'groups'> | undefined): ViewGroup[] {
  return (graph?.groups ?? []).map(group => ({
    name: group.name,
    ...(group.blurb === undefined ? {} : { blurb: group.blurb }),
    stages: [...group.stages],
    ...(group.kind !== undefined && isGroupKind(group.kind) ? { kind: group.kind } : {}),
  }));
}

/**
 * What is wrong with the pack's document as this console reads it: the engine's problems,
 * then each group whose `kind` this console does not draw (`neutral` says so on purpose).
 */
export function documentProblems(
  graph: Pick<PackGraph, 'groups' | 'document'> | undefined
): string[] {
  const unknown = (graph?.groups ?? []).flatMap(({ name, kind }) =>
    kind === undefined || kind === 'neutral' || isGroupKind(kind)
      ? []
      : [`group '${name}' has kind '${kind}', which this console does not draw; it reads neutral`]
  );
  return [...(graph?.document?.problems ?? []), ...unknown];
}
