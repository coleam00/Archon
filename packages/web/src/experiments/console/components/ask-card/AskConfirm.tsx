import type { ReactElement } from 'react';

/** What the confirm row asks for: the chosen words, the textarea when the choice takes text. */
export interface ConfirmDraft {
  /** The chosen tiles' words, in the order chosen; empty for an answer only in words. */
  labels: readonly string[];
  /** Whether the textarea shows, and whether it must hold something before Confirm. */
  text: 'none' | 'optional' | 'required';
  placeholder: string;
}

// A style, not `border-accent-muted`: theme.css's unlayered `.console-root *` border colour
// outranks every border utility (tile-marks.tsx says more).
const CONFIRM_BORDER = { borderColor: 'var(--accent-muted)' } as const;

/**
 * Under the tiles (Visual standard rule 9): the textarea when the choice takes words, then
 * "Answer: <label>" with Confirm, the accent at reduced strength, and a quiet Cancel. Confirm
 * is enabled exactly when `accepted`, which the ask's owner decides; a refusal shows in the
 * server's own words, and the card stays.
 */
export function AskConfirm({
  draft,
  value,
  onChange,
  accepted,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  draft: ConfirmDraft;
  value: string;
  onChange: (text: string) => void;
  accepted: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  /** Absent for an answer only in words, which has nothing to cancel back to. */
  onCancel?: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      {draft.text === 'none' ? null : (
        <textarea
          aria-label="Your answer"
          value={value}
          onChange={event => {
            onChange(event.target.value);
          }}
          rows={3}
          disabled={busy}
          placeholder={draft.placeholder}
          className="w-full resize-y rounded-console-12 border border-border bg-surface-inset px-3 py-2 text-console-14 text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none disabled:opacity-50"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-console-14 text-text-primary [overflow-wrap:anywhere]">
          {draft.labels.length === 0 ? 'Answer in words' : `Answer: ${draft.labels.join(', ')}`}
        </span>
        {onCancel === undefined ? null : (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-console-12 px-3 py-1.5 text-console-13 text-text-secondary transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || !accepted}
          style={CONFIRM_BORDER}
          className="rounded-console-12 border bg-[color:var(--accent-soft)] px-3 py-1.5 text-console-13 font-semibold text-accent transition-colors duration-150 ease-out hover:bg-[color:var(--accent-muted)] disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Confirm'}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-console-13 text-error [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}
