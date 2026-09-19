import { useEffect, useState, type ReactElement } from 'react';
import {
  BRIEF_PARTS,
  EMPTY_BRIEF,
  filledParts,
  isBriefEmpty,
  MAX_BRIEF_PART,
  parseBrief,
  serializeBrief,
  type Brief,
} from '../primitives/brief';
import {
  colorToken,
  conversationLabel,
  isBriefStale,
  type ConversationSummary,
} from '../primitives/conversation';
import { relativeTime } from '../lib/format';

interface BriefModalProps {
  conversation: ConversationSummary;
  onClose: () => void;
  onSave: (brief: string | null) => void;
  /**
   * Hand the summary back to the agent. Undefined when the chat is busy — a
   * refresh queued behind a reply in flight would land minutes later on a
   * summary the user had since edited.
   */
  onRefresh?: () => void;
  /** Open straight into the editor, for the card's `+ summary` affordance. */
  startEditing?: boolean;
}

/**
 * The chat's summary, read and written in a modal rather than in the header.
 *
 * It lived in the header, where it had to be clamped to a few lines to stop the
 * header changing height as the agent rewrote it — so the one place the summary
 * was shown was the one place it could not be read in full. Moving it here
 * gives it the room to be three distinct answers instead of one paragraph, and
 * gives the header back its fixed height.
 *
 * Provenance and age sit in the title bar because a summary you cannot date is
 * one you will keep trusting after it stopped being true.
 */
export function BriefModal({
  conversation,
  onClose,
  onSave,
  onRefresh,
  startEditing = false,
}: BriefModalProps): ReactElement {
  const stored = parseBrief(conversation.brief);
  const [editing, setEditing] = useState(startEditing || stored === null);
  const [draft, setDraft] = useState<Brief>(stored ?? EMPTY_BRIEF);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const token = colorToken(conversation.color) ?? 'var(--brand-magenta)';
  const stale = isBriefStale(conversation);
  const parts = stored === null ? [] : filledParts(stored);

  const commit = (): void => {
    onSave(serializeBrief(draft));
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Summary of ${conversationLabel(conversation)}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative flex max-h-[80vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border bg-surface-elevated text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <div
          className="flex items-center gap-2.5 border-b px-[18px] py-3.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: token }}
          />
          <h2 className="min-w-0 truncate font-mono text-[11.5px] font-bold uppercase tracking-[0.13em] text-text-primary">
            {conversationLabel(conversation)}
          </h2>
          <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
            {editing
              ? '· editing — yours once saved'
              : `· ${conversation.briefPinned ? 'yours' : 'by the agent'}${
                  conversation.briefUpdatedAt !== null
                    ? ` · ${relativeTime(conversation.briefUpdatedAt)}`
                    : ''
                }`}
          </span>
          {stale && !editing ? (
            <span className="shrink-0 font-mono text-[11px] text-warning">· may be stale</span>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {!editing && onRefresh !== undefined ? (
              <BarButton
                onClick={() => {
                  onRefresh();
                  onClose();
                }}
                title="Ask the agent to rewrite this — sends a message to the chat"
              >
                Refresh
              </BarButton>
            ) : null}
            {!editing ? (
              <BarButton
                onClick={() => {
                  setDraft(stored ?? EMPTY_BRIEF);
                  setEditing(true);
                }}
              >
                Edit
              </BarButton>
            ) : null}
            <BarButton onClick={onClose} title="Close" aria-label="Close">
              ✕
            </BarButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {editing ? (
            BRIEF_PARTS.map(p => (
              <div
                key={p.key}
                className="border-b px-[18px] py-3.5 last:border-b-0"
                style={{ borderColor: 'var(--border)' }}
              >
                <label
                  htmlFor={`brief-${p.key}`}
                  className="mb-2 block font-mono text-[10.5px] font-bold tracking-[0.14em]"
                  style={{ color: 'var(--brand-green)' }}
                >
                  {p.label}
                </label>
                <textarea
                  id={`brief-${p.key}`}
                  value={draft[p.key]}
                  onChange={e => {
                    setDraft(d => ({ ...d, [p.key]: e.target.value }));
                  }}
                  rows={3}
                  maxLength={MAX_BRIEF_PART}
                  // Every part is optional on purpose: a throwaway chat fills in
                  // the first box and stops, and three mandatory boxes would
                  // make people write filler to get past them.
                  placeholder="Leave empty if it does not apply"
                  className="w-full resize-none rounded-[9px] border bg-surface px-3 py-2.5 text-[13px] leading-[1.6] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_91%)]"
                  style={{ borderColor: 'var(--border-bright)' }}
                />
              </div>
            ))
          ) : parts.length === 0 ? (
            <p className="px-[18px] py-8 text-center text-[13px] text-text-tertiary">
              No summary yet. Write one, or ask the agent to.
            </p>
          ) : (
            parts.map(p => (
              <div
                key={p.key}
                className="border-b px-[18px] py-3.5 last:border-b-0"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="mb-1.5 font-mono text-[10.5px] font-bold tracking-[0.14em]"
                  style={{ color: 'var(--brand-green)' }}
                >
                  {p.label}
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-[1.65] text-text-primary">
                  {p.text}
                </p>
              </div>
            ))
          )}
        </div>

        {editing ? (
          <div
            className="flex shrink-0 items-center justify-end gap-2.5 border-t px-[18px] py-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <button
              type="button"
              onClick={() => {
                // Cancelling out of an empty summary leaves nothing to read, so
                // close rather than dropping the user on the empty state.
                if (stored === null) onClose();
                else setEditing(false);
              }}
              className="rounded-[9px] border bg-transparent px-4 py-2 text-[12.5px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={isBriefEmpty(draft) && stored === null}
              className="brand-bar rounded-[9px] px-4 py-2 text-[12.5px] font-bold text-white transition-all hover:brightness-110 disabled:opacity-45"
            >
              Save
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BarButton({
  children,
  onClick,
  title,
  'aria-label': ariaLabel,
}: {
  children: string;
  onClick: () => void;
  title?: string;
  'aria-label'?: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="rounded-[8px] border px-2.5 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
      style={{ borderColor: 'var(--border-bright)' }}
    >
      {children}
    </button>
  );
}
