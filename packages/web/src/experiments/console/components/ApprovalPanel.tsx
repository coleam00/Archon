import {
  useEffect,
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

/** `null` (nothing being answered) or the id of the non-default decision being answered. */
type Mode = string | null;

function decisionLabel(id: string, label: string | undefined): string {
  if (label !== undefined && label.length > 0) return label;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Inline approval surface for a paused run.
 *
 * Renders whichever decisions the gate actually declared (#2707 step 2) —
 * `approve`/`reject` for an ordinary gate, or any author-declared vocabulary for
 * one that wrote `approval.decisions:`. Two flows kept visually separate so an
 * accidental non-default decision doesn't happen mid-conversation:
 *
 *   - **`approve`**: one click. The single-line input above is an optional
 *     comment — Archon captures it as `$<node-id>.output.text` so the workflow
 *     can branch on the answer.
 *   - **Every other decision**: two-step. The first click reveals an expanded
 *     textarea for the reviewer's text; the confirm button is only enabled once
 *     the textarea has content. `reject` behaves exactly as it always has — it is simply
 *     one entry in the declared vocabulary now, not a hardcoded second button.
 *
 * Demo runs (id starts with `demo-`) short-circuit to a no-op so the
 * preview UI doesn't hit the backend with bogus ids.
 */
export function ApprovalPanel({ run }: ApprovalPanelProps): ReactElement {
  const [comment, setComment] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDemo = run.id.startsWith('demo-');
  const gateNodeId = run.approval?.nodeId;

  // Reset local state when the paused gate's identity changes — a re-pause of the
  // same run (resolved by another surface, or by a second browser tab) must not
  // leave a stale in-flight decision selected against a DIFFERENT gate. Without
  // this, submitting a half-picked non-default decision after the underlying gate
  // changed could silently resolve the new gate with a decision the user never
  // chose for it (only caught server-side when the new gate happens not to declare
  // the same decision id).
  useEffect(() => {
    setMode(null);
    setComment('');
    setText('');
    setError(null);
    // Deliberately keyed on gate identity ONLY — this must fire when the paused
    // node changes, not on every busy/error state change mid-submit.
  }, [gateNodeId]);
  // Signal-bearing interactive-loop gate (#2074): a bare approve finalizes the
  // node from the already-computed output (no re-run); a comment runs another
  // iteration. Same respond call either way — the backend derives
  // finalize-vs-iterate from comment presence.
  const signalBearing = run.approval?.completionSignaled === true;

  const decisions = run.approval?.decisions ?? [{ id: 'approve' }, { id: 'reject' }];
  const secondaryDecisions = decisions.filter(d => d.id !== 'approve');

  const stopPropagation = (e: MouseEvent | ReactKeyboardEvent): void => {
    e.stopPropagation();
  };

  const respond = async (decisionId: string, rawText: string): Promise<void> => {
    const trimmed = rawText.trim();
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        await new Promise<void>(r => setTimeout(r, 300));
      } else {
        await skill.respondRun(run.id, decisionId, trimmed.length > 0 ? trimmed : undefined);
      }
      invalidate('runs');
      invalidate(`run:${run.id}`);
      setComment('');
      setText('');
      setMode(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Response failed.');
    } finally {
      setBusy(false);
    }
  };

  const onApproveKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    stopPropagation(e);
    // Don't submit while an IME composition is in progress (Japanese,
    // Chinese, Korean, etc. — the first Enter accepts a candidate).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void respond('approve', comment);
    }
  };

  const onSecondaryKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    stopPropagation(e);
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode(null);
      setText('');
      setError(null);
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && mode !== null) {
      e.preventDefault();
      if (text.trim().length > 0) void respond(mode, text);
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

      {mode === null ? (
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            value={comment}
            onChange={e => {
              setComment(e.target.value);
              if (error !== null) setError(null);
            }}
            onKeyDown={onApproveKey}
            placeholder={
              signalBearing
                ? 'add feedback to run another iteration instead'
                : 'optional comment to send with approval'
            }
            disabled={busy}
            autoFocus
            className="min-w-0 flex-1 rounded border border-border bg-surface-inset px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            data-keymap-approve
            onClick={() => void respond('approve', comment)}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded border border-success/40 bg-success/15 px-3 text-[12px] font-medium text-success transition-colors hover:bg-success/25 disabled:opacity-50"
            title={
              signalBearing && comment.trim().length === 0
                ? 'Accept & complete · Enter'
                : 'Continue · Enter'
            }
          >
            {signalBearing && comment.trim().length === 0 ? 'Accept & complete' : 'Continue'}
            <span aria-hidden className="font-mono text-[10px] opacity-70">
              ↵
            </span>
          </button>
          {secondaryDecisions.map(d => (
            <button
              key={d.id}
              type="button"
              data-keymap-reject={d.id === 'reject' ? true : undefined}
              onClick={() => {
                setMode(d.id);
                setError(null);
              }}
              disabled={busy}
              className="shrink-0 rounded border border-error/30 px-3 text-[12px] text-error transition-colors hover:bg-error/10 disabled:opacity-40"
              title={`${decisionLabel(d.id, d.label)} this run`}
            >
              {decisionLabel(d.id, d.label)}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="font-mono text-[10px] uppercase tracking-[0.14em] text-error">
            {decisionLabel(mode, secondaryDecisions.find(d => d.id === mode)?.label)} — text
            required
          </label>
          <textarea
            value={text}
            onChange={e => {
              setText(e.target.value);
              if (error !== null) setError(null);
            }}
            onKeyDown={onSecondaryKey}
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
                  setMode(null);
                  setText('');
                  setError(null);
                }}
                disabled={busy}
                className="rounded px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (text.trim().length > 0) void respond(mode, text);
                }}
                disabled={busy || text.trim().length === 0}
                className="flex items-center gap-1 rounded border border-error/40 bg-error/15 px-3 py-1 text-[12px] font-medium text-error transition-colors hover:bg-error/25 disabled:opacity-40"
              >
                {busy
                  ? 'Sending…'
                  : `${decisionLabel(mode, secondaryDecisions.find(d => d.id === mode)?.label)} run`}
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
