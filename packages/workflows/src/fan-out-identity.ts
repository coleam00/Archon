/**
 * Stable per-item identity for the composed fan-out (#2512).
 *
 * An instance's step names are `<nodeId>__<identity>__<innerNodeId>`, so resume
 * hydration keys on identity: it must be deterministic across reorder, shrink and
 * growth of the item list. Identity is therefore CONTENT-addressed — the first 16 hex
 * chars of SHA-256 over the canonical JSON text of the item value (the same
 * `canonicalValueText` the substitution surfaces use), with `-<k>` appended for
 * byte-identical duplicates (k = 0-based occurrence index in input order). Reordering or
 * shrinking the list never changes a distinct item's identity; removing one copy of a
 * duplicated value renumbers the survivors' ordinals, which cannot mis-hydrate because
 * byte-identical items are observationally interchangeable.
 */
import { createHash } from 'node:crypto';
import { canonicalValueText, type JsonValue } from './output-ref';

/** A snapshot entry for one fan-out instance, persisted as an audit event before scheduling. */
export interface FanOutInstanceSnapshot {
  ordinal: number;
  identity: string;
  item: JsonValue;
  /** Complete resolved `$INPUTS` map frozen before any instance starts. */
  inputs: Record<string, JsonValue>;
}

/**
 * Reserved persisted-step marker for engine-owned composed fan-out state. Authored
 * node ids may not contain it, which keeps instance plans, terminals, and inner rows
 * disjoint from every author-controlled step name across nested loop scopes.
 */
export const COMPOSE_FAN_OUT_STEP_MARKER = '__archon_fan_out__';

export function composeInstanceIdentity(item: JsonValue, duplicateOrdinal: number): string {
  const hash = createHash('sha256').update(canonicalValueText(item)).digest('hex').slice(0, 16);
  return duplicateOrdinal === 0 ? hash : `${hash}-${String(duplicateOrdinal)}`;
}

/** Stable engine-owned scope for one fan-out node in one enclosing loop iteration. */
export function composeFanOutScopeSegment(
  nodeId: string,
  loopGroupPath: readonly { groupId: string; iteration: number }[]
): string {
  const loopIdentity =
    loopGroupPath.length === 0
      ? 'root'
      : composeInstanceIdentity(
          loopGroupPath.map(frame => [frame.groupId, frame.iteration]),
          0
        );
  return `${COMPOSE_FAN_OUT_STEP_MARKER}${nodeId}__${loopIdentity}`;
}

/**
 * Snapshot an ordered item list into instance identities. Duplicate ordinals count per
 * distinct VALUE (the 0-based index among byte-identical items), so removing one copy
 * of a duplicated value does not shift the others' identities.
 */
export function buildInstanceSnapshots(
  items: readonly JsonValue[],
  staticInputs: Readonly<Record<string, JsonValue>> = {},
  itemBinding = 'item'
): FanOutInstanceSnapshot[] {
  const seen = new Map<string, number>();
  return items.map((item, ordinal) => {
    const canonical = canonicalValueText(item);
    const k = seen.get(canonical) ?? 0;
    seen.set(canonical, k + 1);
    return {
      ordinal,
      identity: composeInstanceIdentity(item, k),
      item,
      inputs: { ...staticInputs, [itemBinding]: item },
    };
  });
}
