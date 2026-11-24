/**
 * What waits on the operator in a scope: paused runs that need input, runs holding an item
 * while their owner is gone, and the asks completed runs left on items. The runs page pins
 * it above its feed and the Needs you page shows it for the whole install.
 */
import { useEffect, useMemo, useState } from 'react';
import { useItemAsks, type ItemAsks } from '../components/ItemAsksSection';
import type { OwnerLostHolder, Run } from '../primitives/run';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K, type Scope } from '../store/keys';

function attentionKey(run: Run): string {
  const attention = run.attention;
  return `${run.id}:${attention?.kind === 'awaiting_response' || attention?.kind === 'attention' ? attention.occurrence : ''}`;
}

export interface PendingInput {
  degraded: skill.RunsAttention['degraded'];
  /** Pending-input runs the banner shows: in scope and not dismissed. */
  visible: Run[];
  /** In-scope runs holding their item while their owner is gone. */
  ownerLost: OwnerLostHolder[];
  promotedRunIds: ReadonlySet<string>;
  error: Error | undefined;
  dismiss: (runId: string) => void;
  itemAsks: ItemAsks;
}

/** Runs waiting on the user, for the pending-input banner, minus the ones dismissed this session. */
export function usePendingInput(demoRuns: Run[], scope: Scope): PendingInput {
  // Pending-input runs the user has dismissed from the banner this session.
  // Not persisted — the run is still paused, so it re-surfaces on reload.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const { data: attentionRuns, error } = useEntity<skill.RunsAttention>(
    K.runsAttention,
    skill.listRunsNeedingAttention
  );
  const pendingRuns = useMemo(
    () =>
      [
        ...demoRuns.filter(
          run => run.attention?.kind === 'awaiting_response' || run.attention?.kind === 'attention'
        ),
        ...(attentionRuns?.runs ?? []),
      ].filter(run => scope === 'all' || run.projectId === scope),
    [demoRuns, attentionRuns, scope]
  );

  // Drop dismissed ids that are no longer pending so a run that pauses again
  // (a later approval node, or a repeating interactive loop gate) re-surfaces
  // instead of staying suppressed for the rest of the session.
  useEffect(() => {
    setDismissed(prev => {
      if (prev.size === 0) return prev;
      const pendingIds = new Set(pendingRuns.map(r => attentionKey(r)));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pendingIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingRuns]);

  const visible = useMemo(
    () => pendingRuns.filter(r => !dismissed.has(attentionKey(r))),
    [pendingRuns, dismissed]
  );
  const promotedRunIds = useMemo(() => new Set(visible.map(r => r.id)), [visible]);
  const dismiss = (runId: string): void => {
    setDismissed(prev => {
      const next = new Set(prev);
      const run = pendingRuns.find(run => run.id === runId);
      if (run !== undefined) next.add(attentionKey(run));
      return next;
    });
  };
  const degraded = (attentionRuns?.degraded ?? []).map(report =>
    scope === 'all' ? report : { type: report.type, reason: report.reason }
  );
  const itemAsks = useItemAsks(attentionRuns, scope);
  const ownerLost = useMemo(
    () =>
      (attentionRuns?.ownerLost ?? []).filter(
        holder => scope === 'all' || holder.projectId === scope
      ),
    [attentionRuns, scope]
  );
  return {
    visible,
    ownerLost,
    promotedRunIds,
    degraded,
    error,
    dismiss,
    itemAsks,
  };
}
