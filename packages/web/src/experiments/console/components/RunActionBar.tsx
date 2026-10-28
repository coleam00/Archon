import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import * as skill from '../skills';
import { HttpError } from '../lib/http';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { Run } from '../primitives/run';
import { isLegacyAttention } from './AttentionAnswerPanel';

type RunAction = 'cancel' | 'resume' | 'abandon';

interface RunActionBarProps {
  run: Run;
}

function offersRunningAbandon(run: Run, cancelRefused: boolean): boolean {
  return run.status === 'running' && (cancelRefused || run.ownerObservation === 'unreachable');
}

/**
 * Sticky bottom action bar. Contents are state-sensitive:
 *   running   → Cancel; Abandon too when the server reports the owner unreachable or
 *               once cancel was refused (409: no live owner answered, or it could not
 *               be stopped). Abandon is then how the
 *               operator releases a run whose process is gone.
 *   paused    → Abandon for attention and provider-limit waits; Resume too for a
 *               provider-limit wait (it continues by itself, Resume tries sooner) and for
 *               an attention wait paused before answers existed; AttentionAnswerPanel
 *               answers attention waits, gates use ApprovalPanel
 *   failed    → Resume · Abandon
 *   completed → Re-run when the run has a project
 *   cancelled → Re-run
 *
 * Demo runs short-circuit the backend calls.
 */
export function RunActionBar({ run }: RunActionBarProps): ReactElement | null {
  const [busy, setBusy] = useState<RunAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelRefused, setCancelRefused] = useState(false);
  const isDemo = run.id.startsWith('demo-');

  const call = async (action: RunAction): Promise<void> => {
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
      if (action === 'cancel' && e instanceof HttpError && e.status === 409) {
        setCancelRefused(true);
      }
      setError(actionErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const abandonableWait =
    run.attention?.kind === 'attention' || run.attention?.kind === 'usage_limit';
  if (run.status === 'paused' && !abandonableWait) return null;
  // An attention wait is answered in its own panel; only one paused before answers
  // existed still continues with a bare resume.
  const canResume = offersResume(run);

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

        {offersRunningAbandon(run, cancelRefused) ? (
          <AbandonButton busy={busy} onClick={() => void call('abandon')} />
        ) : null}

        {run.status === 'failed' || abandonableWait ? (
          <>
            {canResume ? (
              <button
                type="button"
                onClick={() => void call('resume')}
                disabled={busy !== null}
                className="brand-bar rounded-[9px] px-5 py-2.5 text-[13px] font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
              >
                {busy === 'resume' ? 'Resuming…' : 'Resume'}
              </button>
            ) : null}
            <AbandonButton busy={busy} onClick={() => void call('abandon')} />
          </>
        ) : null}

        <RerunAction run={run} />

        {error !== null ? (
          <span className="ml-2 whitespace-pre-line font-mono text-[11px] text-error">{error}</span>
        ) : null}
      </div>
    </div>
  );
}

function offersResume(run: Run): boolean {
  return (
    run.status === 'failed' ||
    run.attention?.kind === 'usage_limit' ||
    (run.attention?.kind === 'attention' && isLegacyAttention(run.attention))
  );
}

function RerunAction({ run }: RunActionBarProps): ReactElement | null {
  const navigate = useNavigate();
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

  return canRerun ? (
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
      This run is {run.status}. Choose a project to start a new run.
    </span>
  ) : null;
}

function actionErrorMessage(error: unknown): string {
  return error instanceof HttpError && error.serverError !== undefined
    ? error.serverError
    : error instanceof Error
      ? error.message
      : 'Action failed.';
}

function AbandonButton({
  busy,
  onClick,
}: {
  busy: RunAction | null;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy !== null}
      className="rounded-[9px] border bg-surface-elevated px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
      // Inline because the console scope's wildcard border-color rule
      // repaints Tailwind border utilities (see theme.css).
      style={{ borderColor: 'var(--border-bright)' }}
    >
      {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
    </button>
  );
}
