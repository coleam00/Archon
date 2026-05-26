import { useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { decodeDragPayload, DRAG_MIME } from '../lib/drag-payload';
import type { StartRunArgs } from '../skills/startRun';

interface ExecuteDropZoneProps {
  projectId: string;
  projectCwd: string;
}

/**
 * Pure helper: decode the drag-transfer payload, validate it, and call the
 * provided `startRun` function. Returns `false` (no-op) when the payload is
 * invalid or from a demo run; returns `true` when `startRun` was called.
 *
 * Exported for unit testing without rendering the component.
 */
export async function handleExecuteDrop(
  rawPayload: string,
  projectId: string,
  startRunFn: (args: StartRunArgs) => Promise<void>
): Promise<boolean> {
  const payload = decodeDragPayload(rawPayload);
  if (payload === null) return false;
  // Demo runs are draggable for visual purposes but must not trigger real work.
  if (payload.runId.startsWith('demo-')) return false;
  await startRunFn({ projectId, workflow: 'implement', message: payload.message });
  return true;
}

/**
 * ExecuteDropZone — accepts a dragged run card and enqueues a new `implement`
 * agent work order via `skill.startRun`.
 *
 * Drop target semantics:
 * - Accepts cards carrying `application/archon-run` data (set by ActiveRunCard
 *   and RecentRunRow on `dragstart`).
 * - Always uses `workflow: 'implement'`, regardless of the source run's
 *   original workflow.
 * - Demo runs (id starts with `demo-`) are silently ignored.
 * - While a run is being dispatched (`submitting`), subsequent drops are no-ops.
 *
 * Renders only in the scoped-project view (i.e. `draftProject !== null` in
 * RunsPage). The parent controls visibility.
 */
export function ExecuteDropZone({
  projectId,
  projectCwd: _projectCwd,
}: ExecuteDropZoneProps): ReactElement {
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragActive) setDragActive(true);
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    // Only un-flag when leaving the bounding rect, not on each child crossover.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragActive(false);
    if (submitting) return;

    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (raw.length === 0) return;

    setError(null);
    setSubmitting(true);

    void handleExecuteDrop(raw, projectId, skill.startRun)
      .then(dispatched => {
        if (dispatched) {
          invalidate('runs');
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to start run.');
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <div
      role="region"
      aria-label="Execute drop zone"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex min-h-[56px] items-center justify-center rounded border border-dashed px-4 py-3 transition-colors ${
        dragActive
          ? 'border-accent-bright/60 bg-accent/10 text-accent-bright'
          : 'border-border bg-surface-inset text-text-tertiary'
      }${submitting ? ' opacity-60' : ''}`}
    >
      <span className="select-none font-mono text-[11px]">
        {submitting
          ? 'Starting…'
          : dragActive
            ? 'Drop to Execute'
            : 'Drop a run card here to Execute'}
      </span>
      {error !== null ? (
        <span className="ml-3 font-mono text-[11px] text-error">{error}</span>
      ) : null}
    </div>
  );
}
