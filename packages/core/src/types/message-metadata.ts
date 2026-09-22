/**
 * Projection from `MessageMetadata` to its persisted subset.
 *
 * `segment` is intentionally transient — it tells adapters how to lay out the
 * live stream but is never written to message history. All other fields ride
 * through so a future field added to `MessageMetadata` flows to every writer
 * by default rather than per-adapter memory (the class drift fixed by #2709).
 *
 * Returns `undefined` when the projection would have no keys so callers can
 * pass it straight to `addMessage` and preserve the historical "omit when
 * empty" behaviour pinned by existing CLI and headless tests.
 *
 * Accepts the structurally-identical `WorkflowMessageMetadata` (defined in
 * `@archon/workflows/deps` to keep the workflows package free of any
 * `@archon/core` dependency) so a single projection covers every adapter.
 */
import type { MessageMetadata } from './index';

type TransientKey = 'segment';

/** Minimal contract for any MessageMetadata-like input — keep this narrow. */
export interface MessageMetadataLike {
  category?: MessageMetadata['category'];
  segment?: MessageMetadata['segment'];
  workflowDispatch?: MessageMetadata['workflowDispatch'];
  workflowResult?: MessageMetadata['workflowResult'];
}

export type PersistedMessageMetadata = {
  [K in Exclude<keyof MessageMetadataLike, TransientKey>]?: MessageMetadataLike[K];
} & Record<string, unknown>;

export function toPersistedMessageMetadata(
  metadata: MessageMetadataLike | undefined
): PersistedMessageMetadata | undefined {
  if (!metadata) return undefined;

  const projection: Record<string, unknown> = {};
  for (const key of Object.keys(metadata) as (keyof MessageMetadataLike)[]) {
    if (key === 'segment') continue;
    const value = metadata[key];
    if (value !== undefined) {
      projection[key] = value;
    }
  }

  return Object.keys(projection).length > 0 ? projection : undefined;
}
