import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import type { Run } from '../primitives/run';

interface ApprovalPanelProps {
  run: Run;
}

type Mode = 'idle' | 'rejecting';

/**
 * Inline approval surface for a paused run.
 *
 * Two distinct flows kept visually separate so accidental rejects don't
 * happen mid-conversation:
 *
 *   - **Continue / Approve**: one click. The single-line input above is an
 *     optional comment — Archon captures it as `$<node-id>.output` so the
 *     workflow can branch on the answer.
 *   - **Reject**: two-step. The first click reveals an expanded textarea
 *     for the reason; the confirm button is only enabled once the textarea
 *     has content. Mirrors the old UI's ConfirmRunActionDialog flow without
 *     a modal.
 *
 * Demo runs (id starts with `demo-`) short-circuit to a no-op so the
 * preview UI doesn't hit the backend with bogus ids.
 */
export function ApprovalPanel({ run }: ApprovalPanelProps): ReactElement {
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDemo = run.id.startsWith('demo-');

  const stopPropagation = (e: MouseEvent | ReactKeyboardEvent): void => {
    e.stopPropagation();
  };

  const approve = async (): Promise<void> => {
    const trimmed = comment.trim();
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        await new Promise<void>(r => setTimeout(r, 300));
      } else {
        await skill.approveRun(run.id, trimmed.length > 0 ? trimmed : undefined);
      }
      invalidate('runs');
      invalidate(`run:${run.id}`);
      setComment('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Approve failed.');
    } finally {
      setBusy(false);
    }
  };

  const confirmReject = async (): Promise<void> => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError('Reject requires a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        await new Promise<void>(r => setTimeout(r, 300));
      } else {
        await skill.rejectRun(run.id, trimmed);
      }
      invalidate('runs');
      invalidate(`run:${run.id}`);
      setReason('');
      setMode('idle');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reject failed.');
    } finally {
      setBusy(false);
    }
  };

  const onApproveKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    stopPropagation(e);
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void approve();
    }
  };

  const onRejectKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    stopPropagation(e);
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode('idle');
      setReason('');
      setError(null);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void confirmReject();
    }
  };

  return (
    <div
      className="mt-2 rounded border border-warning/30 bg-warning/[0.06] p-3"
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
    >
      {run.approval?.message.length ? (
        <p className="mb-2 text-[12px] uppercase tracking-[0.12em] text-warning">
          {run.approval.message}
        </p>
      ) : null}

      {mode === 'idle' ? (
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={comment}
            onChange={e => {
              setComment(e.target.value);
              if (error !== null) setError(null);
            }}
            onKeyDown={onApproveKey}
            placeholder="optional comment to send with approval"
            disabled={busy}
            autoFocus
            className="min-w-0 flex-1 rounded border border-border bg-surface-inset px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            data-keymap-approve
            onClick={() => void approve()}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded border border-success/40 bg-success/15 px-3 text-[12px] font-medium text-success transition-colors hover:bg-success/25 disabled:opacity-50"
            title="Continue · Enter"
          >
            Continue
            <span aria-hidden className="font-mono text-[10px] opacity-70">
              ↵
            </span>
          </button>
          <button
            type="button"
            data-keymap-reject
            onClick={() => {
              setMode('rejecting');
              setError(null);
            }}
            disabled={busy}
            className="shrink-0 rounded border border-error/30 px-3 text-[12px] text-error transition-colors hover:bg-error/10 disabled:opacity-40"
            title="Reject this run"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-error">
            Reason for rejecting · required
          </label>
          <textarea
            value={reason}
            onChange={e => {
              setReason(e.target.value);
              if (error !== null) setError(null);
            }}
            onKeyDown={onRejectKey}
            placeholder="why is the agent going the wrong way? this is sent back as feedback."
            rows={3}
            disabled={busy}
            autoFocus
            className="w-full resize-none rounded border border-error/30 bg-surface-inset px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-error/60 focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-text-tertiary">
              ⌘↵ confirm · esc cancel
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode('idle');
                  setReason('');
                  setError(null);
                }}
                disabled={busy}
                className="rounded px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmReject()}
                disabled={busy || reason.trim().length === 0}
                className="flex items-center gap-1 rounded border border-error/40 bg-error/15 px-3 py-1 text-[12px] font-medium text-error transition-colors hover:bg-error/25 disabled:opacity-40"
              >
                {busy ? 'Rejecting…' : 'Reject run'}
                <span aria-hidden className="font-mono text-[10px] opacity-70">
                  ⌘↵
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {error !== null ? <p className="mt-1 font-mono text-[11px] text-error">{error}</p> : null}
    </div>
  );
}
