import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
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
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'cancel' | 'resume' | 'abandon' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDemo = run.id.startsWith('demo-');

  const canRerun =
    run.projectId !== null &&
    run.workflow !== '' &&
    !isDemo &&
    (run.status === 'completed' || run.status === 'cancelled');

  const onRerun = (): void => {
    if (!canRerun || run.projectId === null) return;
    const params = new URLSearchParams({ rerun: '1', workflow: run.workflow });
    if (run.userMessage !== '') params.set('message', run.userMessage);
    navigate(`/console/p/${run.projectId}?${params.toString()}`);
  };

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
    <div className="sticky bottom-0 border-t border-border bg-surface px-[30px] py-3.5">
      <div className="flex items-center gap-[11px]">
        {run.status === 'running' ? (
          <button
            type="button"
            onClick={() => void call('cancel')}
            disabled={busy !== null}
            className="rounded-[9px] border border-error/40 px-[18px] py-2.5 text-[13px] font-semibold text-error transition-colors hover:bg-error/10 disabled:opacity-50"
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
              className="brand-bar rounded-[9px] px-5 py-2.5 text-[13px] font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
            >
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
            <button
              type="button"
              onClick={() => void call('abandon')}
              disabled={busy !== null}
              className="rounded-[9px] border bg-surface-elevated px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              // Inline because the console scope's wildcard border-color rule
              // repaints Tailwind border utilities (see theme.css).
              style={{ borderColor: 'var(--border-bright)' }}
            >
              {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
            </button>
          </>
        ) : null}

        {canRerun ? (
          <button
            type="button"
            onClick={onRerun}
            className="rounded-[9px] border bg-surface-elevated px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            Re-run
          </button>
        ) : run.status === 'completed' || run.status === 'cancelled' ? (
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
