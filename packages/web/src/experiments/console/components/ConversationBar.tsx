import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import {
  byMostRecent,
  colorToken,
  conversationLabel,
  CONVERSATION_COLORS,
  type ConversationColor,
  type ConversationSummary,
} from '../primitives/conversation';

interface ConversationBarProps {
  conversations: ConversationSummary[];
  /** `null` while a new chat is pending — it exists only once the first message is sent. */
  activeConvId: string | null;
  onSelect: (id: string | null) => void;
  onRename: (id: string, title: string) => void;
  onRecolor: (id: string, color: ConversationColor | null) => void;
  disabled: boolean;
}

/**
 * Switch between a project's chats, start a new one, and rename the current one.
 *
 * A project's chat used to be a single ever-growing thread with no way to reset
 * — the escape hatch named as recommendation #1 in `console-open-questions.md`.
 *
 * A native `<select>` rather than a custom popover: it is keyboard- and
 * screen-reader-correct for free, and this is a switcher, not a surface that
 * needs bespoke behaviour.
 */
export function ConversationBar({
  conversations,
  activeConvId,
  onSelect,
  onRename,
  onRecolor,
  disabled,
}: ConversationBarProps): ReactElement {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  const ordered = [...conversations].sort(byMostRecent);
  const active = ordered.find(c => c.id === activeConvId) ?? null;

  const commit = (): void => {
    const next = draft.trim();
    // An empty rename is a no-op, not a way to blank the title — a nameless row
    // in the switcher cannot be told apart from any other.
    if (next.length > 0 && active !== null && next !== conversationLabel(active)) {
      onRename(active.id, next);
    }
    setRenaming(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setRenaming(false);
    }
  };

  const activeToken = colorToken(active?.color ?? null);

  return (
    <div className="flex items-center gap-[8px]">
      <span
        aria-hidden
        className="h-[10px] w-[10px] shrink-0 rounded-full border"
        style={{
          background: activeToken ?? 'transparent',
          borderColor: activeToken ?? 'var(--border-bright)',
        }}
      />
      {renaming && active !== null ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
          maxLength={255}
          aria-label="Rename chat"
          className="min-w-0 flex-1 rounded-[8px] border bg-[color:var(--surface-elevated)] px-[9px] py-[4px] text-[12px] text-text-primary focus:outline-none"
          style={{ borderColor: 'var(--border-bright)' }}
        />
      ) : (
        <select
          value={activeConvId ?? ''}
          onChange={e => {
            onSelect(e.target.value === '' ? null : e.target.value);
          }}
          aria-label="Chat"
          className="min-w-0 flex-1 truncate rounded-[8px] border bg-[color:var(--surface-elevated)] px-[9px] py-[4px] text-[12px] text-text-primary focus:outline-none"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          {activeConvId === null ? <option value="">New chat — not started yet</option> : null}
          {ordered.map(c => (
            <option key={c.id} value={c.id}>
              {conversationLabel(c)}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        onClick={() => {
          if (active === null) return;
          setDraft(conversationLabel(active));
          setRenaming(true);
        }}
        disabled={active === null || renaming}
        title={active === null ? 'Send a message first' : 'Rename this chat'}
        className="shrink-0 rounded-[8px] border px-[9px] py-[4px] text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-default disabled:opacity-40"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        Rename
      </button>

      <button
        type="button"
        onClick={() => {
          onSelect(null);
        }}
        // Disabled mid-turn: the reply belongs to the chat that asked for it.
        disabled={disabled || activeConvId === null}
        title={activeConvId === null ? 'Already on a new chat' : 'Start a new chat'}
        className="shrink-0 rounded-[8px] border px-[9px] py-[4px] text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-default disabled:opacity-40"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        + New chat
      </button>

      {/*
        Colour is never the only channel: each swatch carries its name as its
        accessible label and its tooltip, so the label survives colour blindness
        and screen readers.
      */}
      <div className="flex shrink-0 items-center gap-[4px]" role="group" aria-label="Chat colour">
        {CONVERSATION_COLORS.map(({ value, label, token }) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              if (active === null) return;
              // Clicking the current colour clears it, so the picker is its own
              // undo and needs no separate "none" control.
              onRecolor(active.id, active.color === value ? null : value);
            }}
            disabled={active === null}
            aria-label={label}
            aria-pressed={active?.color === value}
            title={active?.color === value ? `${label} — click to clear` : label}
            className="h-[14px] w-[14px] rounded-full border transition-transform hover:scale-110 disabled:cursor-default disabled:opacity-40"
            style={{
              background: token,
              borderColor:
                active?.color === value
                  ? 'var(--text-primary)'
                  : 'color-mix(in oklch, black, transparent 70%)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
