import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { Run } from '../primitives/run';

interface RunActionBarProps {
  run: Run;
}

/**
 * Sticky bottom action bar. Contents are state-sensitive:
 *   running   → Cancel
 *   paused    → (nothing — the in-stream ApprovalPanel is the action surface)
 *   failed    → Resume · Abandon
 *   completed → Re-run (placeholder for M5 — navigates to the scoped Runs page)
 *   cancelled → Re-run
 *
 * Demo runs short-circuit the backend calls.
 */
export function RunActionBar({ run }: RunActionBarProps): ReactElement | null {
  const [busy, setBusy] = useState<'cancel' | 'resume' | 'abandon' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDemo = run.id.startsWith('demo-');

  const call = async (action: 'cancel' | 'resume' | 'abandon'): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      if (!isDemo) {
        if (action === 'cancel') await skill.cancelRun(run.id);
        if (action === 'resume') await skill.resumeRun(run.id);
        if (action === 'abandon') await skill.abandonRun(run.id);
      }
      invalidate('runs');
      invalidate(K.run(run.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  if (run.status === 'paused') return null;

  return (
    <div className="sticky bottom-0 border-t border-border bg-surface px-6 py-3">
      <div className="flex items-center gap-2">
        {run.status === 'running' ? (
          <button
            type="button"
            onClick={() => void call('cancel')}
            disabled={busy !== null}
            className="rounded border border-error/40 px-3 py-1.5 text-[12px] font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}

        {run.status === 'failed' ? (
          <>
            <button
              type="button"
              onClick={() => void call('resume')}
              disabled={busy !== null}
              className="rounded bg-accent-bright px-3 py-1.5 text-[12px] font-medium text-white/95 transition-opacity hover:brightness-110 disabled:opacity-50"
            >
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
            <button
              type="button"
              onClick={() => void call('abandon')}
              disabled={busy !== null}
              className="rounded border border-border px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            >
              {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
            </button>
          </>
        ) : null}

        {run.status === 'completed' || run.status === 'cancelled' ? (
          <span className="text-[12px] text-text-tertiary">
            This run is {run.status}. Start a new one from the project page.
          </span>
        ) : null}

        {error !== null ? (
          <span className="ml-2 font-mono text-[11px] text-error">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
