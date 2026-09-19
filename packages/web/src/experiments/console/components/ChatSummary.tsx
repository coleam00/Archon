import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { colorToken, isBriefStale, type ConversationSummary } from '../primitives/conversation';
import { relativeTime } from '../lib/format';

interface ChatSummaryProps {
  conversation: ConversationSummary;
  onSave: (brief: string | null) => void;
}

/**
 * The chat's summary, pinned above the message stream.
 *
 * The rail's card clamps the same text to two lines; this shows all of it. They
 * are a preview and the thing itself, not duplicates — the card answers "which
 * chat is this" while scanning, and this answers "where had I got to" on
 * arrival.
 *
 * The age line is load-bearing. A summary that cannot be dated is one the
 * reader will trust after it has stopped being true, so an old one says so
 * rather than sitting there looking current.
 */
export function ChatSummary({ conversation, onSave }: ChatSummaryProps): ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const { brief, briefUpdatedAt, briefPinned } = conversation;
  // Nothing to show and nothing to edit: an empty card on a fresh chat is
  // furniture, not information.
  if (brief === null && !editing) return null;

  const token = colorToken(conversation.color) ?? 'var(--brand-magenta)';
  const stale = isBriefStale(conversation);

  const commit = (): void => {
    const next = draft.trim();
    onSave(next.length > 0 ? next : null);
    setEditing(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter saves; Shift+Enter is a newline, matching the composer.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  };

  return (
    <div
      className="ml-auto min-w-0 max-w-[560px] flex-1 rounded-[10px] border bg-surface-elevated px-3 py-2"
      style={{ borderColor: 'var(--border-bright)', borderLeft: `3px solid ${token}` }}
    >
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.16em] text-text-tertiary">
        <span>SUMMARY</span>
        <span className="font-normal tracking-normal">
          {briefPinned ? '· yours' : '· written by the agent'}
          {briefUpdatedAt !== null ? ` · ${relativeTime(briefUpdatedAt)}` : ''}
        </span>
        {stale ? (
          <span className="font-normal tracking-normal text-warning">· may be stale</span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setDraft(brief ?? '');
            setEditing(true);
          }}
          className="ml-auto rounded-[7px] border px-2 py-[3px] text-[10px] font-normal tracking-normal text-text-secondary transition-colors hover:text-text-primary"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          Edit
        </button>
      </div>

      {editing ? (
        <textarea
          ref={ref}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
          rows={4}
          maxLength={2000}
          aria-label="Chat summary"
          placeholder="What are we doing, where are we, what's left?"
          className="w-full resize-none rounded-[8px] border bg-surface px-3 py-2 text-[13px] leading-[1.6] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          style={{ borderColor: 'var(--border-bright)' }}
        />
      ) : (
        <p className="line-clamp-2 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-text-primary">
          {brief}
        </p>
      )}
    </div>
  );
}
