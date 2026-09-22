/**
 * Projection from a MessageMetadata-like input to its persisted subset.
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
 * Accepts any object so the structurally-identical `WorkflowMessageMetadata`
 * (defined in `@archon/workflows/deps` to keep workflows free of any
 * `@archon/core` dependency) flows through one projection alongside
 * `MessageMetadata` itself. The input is field-agnostic — runtime walks
 * `Object.entries` rather than enumerating fields.
 */
export function toPersistedMessageMetadata(
  metadata: object | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const projection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (key === 'segment') continue;
    if (value !== undefined) {
      projection[key] = value;
    }
  }

  return Object.keys(projection).length > 0 ? projection : undefined;
}
