import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { rerunPath } from '../lib/rerun';
import { useRunActions, type RunAction } from '../lib/use-run-actions';
import type { Run } from '../primitives/run';
import { isLegacyAttention } from './AttentionAnswerPanel';

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
 *   failed    → Resume · Abandon · Re-run; no Resume for a run that failed at launch,
 *               which has no checkout to resume in
 *   completed → Re-run when the run has a project
 *   cancelled → Re-run
 */
export function RunActionBar({ run }: RunActionBarProps): ReactElement | null {
  const { busy, error, notice, cancelRefused, call } = useRunActions(run);

  const abandonableWait =
    run.attention?.kind === 'attention' || run.attention?.kind === 'usage_limit';
  if (run.status === 'paused' && !abandonableWait) return null;
  // An attention wait is answered in its own panel; only one paused before answers
  // existed still continues with a bare resume.
  const canResume = offersResume(run);

  return (
    <div className="sticky bottom-0 border-t border-border bg-surface px-7.5 py-3.5">
      <div className="flex items-center gap-2.75">
        {run.status === 'running' ? (
          <button
            type="button"
            onClick={() => void call('cancel')}
            disabled={busy !== null}
            className="rounded-lg border border-error/40 px-4.5 py-2.5 text-console-13 font-semibold text-error transition-colors hover:bg-error/10 disabled:opacity-50"
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
                className="brand-bar rounded-lg px-5 py-2.5 text-console-13 font-bold text-white shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
              >
                {busy === 'resume' ? 'Resuming…' : 'Resume'}
              </button>
            ) : null}
            <AbandonButton busy={busy} onClick={() => void call('abandon')} />
          </>
        ) : null}

        <RerunAction run={run} />

        <ActionFeedback notice={notice} error={error} />
      </div>
    </div>
  );
}

function ActionFeedback({
  notice,
  error,
}: {
  notice: string | null;
  error: string | null;
}): ReactElement | null {
  if (error !== null) {
    return (
      <span className="ml-2 whitespace-pre-line font-mono text-console-11 text-error">{error}</span>
    );
  }
  return notice !== null ? (
    <span role="status" className="ml-2 font-mono text-console-11 text-text-secondary">
      {notice}
    </span>
  ) : null;
}

function offersResume(run: Run): boolean {
  return (
    (run.status === 'failed' && run.stopReason?.reason !== 'launch_failed') ||
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
    run.status !== 'running' &&
    run.status !== 'paused';

  const onRerun = (): void => {
    if (!canRerun || run.projectId === null) return;
    navigate(rerunPath({ ...run, projectId: run.projectId }));
  };

  return canRerun ? (
    <button
      type="button"
      onClick={onRerun}
      className="rounded-lg border bg-surface-elevated px-4.5 py-2.5 text-console-13 font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
      style={{ borderColor: 'var(--border-bright)' }}
    >
      Re-run
    </button>
  ) : run.status === 'completed' || run.status === 'cancelled' ? (
    <span className="text-console-12 text-text-tertiary">
      This run is {run.status}. Choose a project to start a new run.
    </span>
  ) : null;
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
      className="rounded-lg border bg-surface-elevated px-4.5 py-2.5 text-console-13 font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
      // Inline because the console scope's wildcard border-color rule
      // repaints Tailwind border utilities (see theme.css).
      style={{ borderColor: 'var(--border-bright)' }}
    >
      {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
    </button>
  );
}
