import type {
  Lifecycle,
  SymphonyCard,
  SymphonyDispatchRow,
  SymphonyDispatchStatus,
  SymphonyStateResponse,
} from './types';

const TERMINAL_STATUSES: ReadonlySet<SymphonyDispatchStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function dispatchStatusToLifecycle(status: SymphonyDispatchStatus): Lifecycle | null {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return null;
}

/**
 * Build a unified `SymphonyCard[]` from the live state and the historical
 * dispatch table. Cards are keyed by `dispatch_key` and the live state wins —
 * a stale terminal dispatch row from a prior attempt must NOT displace the
 * card for the currently-running attempt of the same issue.
 */
export function buildCards(
  state: SymphonyStateResponse | undefined,
  dispatches: SymphonyDispatchRow[] | undefined
): SymphonyCard[] {
  const byKey = new Map<string, SymphonyCard>();
  const dispatchByKey = indexLatestDispatchPerKey(dispatches ?? []);

  if (state) {
    for (const r of state.running) {
      const d = dispatchByKey.get(r.dispatch_key);
      byKey.set(r.dispatch_key, {
        dispatch_key: r.dispatch_key,
        tracker: r.tracker,
        issue_id: r.issue_id,
        identifier: r.issue_identifier,
        lifecycle: 'running',
        status: r.state,
        workflow_name: d?.workflow_name ?? null,
        workflow_run_id: r.workflow_run_id ?? d?.workflow_run_id ?? null,
        attempt: d?.attempt ?? null,
        due_at: null,
        last_error: d?.last_error ?? null,
        started_at: r.started_at,
        dispatched_at: d?.dispatched_at ?? null,
      });
    }
    for (const r of state.retrying) {
      if (byKey.has(r.dispatch_key)) continue;
      const d = dispatchByKey.get(r.dispatch_key);
      byKey.set(r.dispatch_key, {
        dispatch_key: r.dispatch_key,
        tracker: r.tracker,
        issue_id: r.issue_id,
        identifier: r.issue_identifier,
        lifecycle: 'retrying',
        status: null,
        workflow_name: d?.workflow_name ?? null,
        workflow_run_id: d?.workflow_run_id ?? null,
        attempt: r.attempt,
        due_at: r.due_at,
        last_error: r.error,
        started_at: null,
        dispatched_at: d?.dispatched_at ?? null,
      });
    }
  }

  for (const d of dispatches ?? []) {
    if (byKey.has(d.dispatch_key)) continue;
    const lifecycle = dispatchStatusToLifecycle(d.status);
    if (!lifecycle) continue;
    byKey.set(d.dispatch_key, {
      dispatch_key: d.dispatch_key,
      tracker: d.tracker,
      issue_id: d.issue_id,
      identifier: d.identifier,
      lifecycle,
      status: null,
      workflow_name: d.workflow_name,
      workflow_run_id: d.workflow_run_id,
      attempt: d.attempt,
      due_at: null,
      last_error: d.last_error,
      started_at: null,
      dispatched_at: d.dispatched_at,
    });
  }

  return [...byKey.values()];
}

/**
 * The dispatches list may contain multiple historical rows for a given
 * `dispatch_key` (one per attempt). For card enrichment we want the most
 * recent one, judged by `dispatched_at`.
 */
function indexLatestDispatchPerKey(
  dispatches: SymphonyDispatchRow[]
): Map<string, SymphonyDispatchRow> {
  const out = new Map<string, SymphonyDispatchRow>();
  for (const d of dispatches) {
    const prev = out.get(d.dispatch_key);
    if (!prev || prev.dispatched_at < d.dispatched_at) {
      out.set(d.dispatch_key, d);
    }
  }
  return out;
}

export { TERMINAL_STATUSES };
