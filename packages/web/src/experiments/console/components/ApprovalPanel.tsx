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

/**
 * Inline approval surface for a paused run. Text field is dual-purpose:
 *   - On **Approve**: treated as optional comment (can be empty).
 *   - On **Reject**: required as reason (button disabled until non-empty).
 *
 * Archon's approval node can capture the text as `$<node-id>.output` so
 * downstream workflow steps receive it — that's why the input is a general
 * "context" field, not just "reason on reject."
 *
 * Demo runs (id starts with `demo-`) short-circuit to a no-op so the preview
 * UI doesn't hit the backend with bogus ids.
 */
export function ApprovalPanel({ run }: ApprovalPanelProps): ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDemo = run.id.startsWith('demo-');

  const stopPropagation = (e: MouseEvent | ReactKeyboardEvent): void => {
    e.stopPropagation();
  };

  const act = async (intent: 'approve' | 'reject'): Promise<void> => {
    const trimmed = text.trim();
    if (intent === 'reject' && trimmed.length === 0) {
      setError('Reject requires a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        // Preview only — fake latency so the user sees the loading state.
        await new Promise<void>(r => setTimeout(r, 300));
      } else if (intent === 'approve') {
        await skill.approveRun(run.id, trimmed.length > 0 ? trimmed : undefined);
      } else {
        await skill.rejectRun(run.id, trimmed);
      }
      // Force a refetch of all run lists and this run's detail.
      invalidate('runs:');
      invalidate(`run:${run.id}`);
      setText('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    stopPropagation(e);
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void act('approve');
    }
  };

  const trimmedEmpty = text.trim().length === 0;

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
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={text}
          onChange={e => {
            setText(e.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={handleKey}
          placeholder="your answer · or reason to reject"
          disabled={busy}
          autoFocus
          className="min-w-0 flex-1 rounded border border-border bg-surface-inset px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void act('approve')}
          disabled={busy}
          className="flex shrink-0 items-center gap-1 rounded border border-success/40 bg-success/15 px-3 text-[12px] font-medium text-success transition-colors hover:bg-success/25 disabled:opacity-50"
          title="Continue · Enter (sends your answer / approves)"
        >
          Continue
          <span aria-hidden className="font-mono text-[10px] opacity-70">
            ↵
          </span>
        </button>
        <button
          type="button"
          onClick={() => void act('reject')}
          disabled={busy || trimmedEmpty}
          className="shrink-0 rounded border border-error/30 px-3 text-[12px] text-error transition-colors hover:bg-error/10 disabled:opacity-40"
          title={trimmedEmpty ? 'Add a reason to reject' : 'Reject and stop the run'}
        >
          Reject
        </button>
      </div>
      {error !== null ? <p className="mt-1 font-mono text-[11px] text-error">{error}</p> : null}
    </div>
  );
}
