import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import {
  byMostRecent,
  colorToken,
  conversationLabel,
  conversationMonogram,
  CONVERSATION_COLORS,
  isBriefStale,
  matchesFilter,
  type ConversationColor,
  type ConversationSummary,
} from '../primitives/conversation';
import { relativeTime } from '../lib/format';

/** Which archived state the rail is showing. */
export type ArchiveScope = 'active' | 'archived' | 'all';

const SCOPES: readonly { value: ArchiveScope; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

interface ConversationRailProps {
  conversations: ConversationSummary[];
  /** `null` while a new chat is pending — it exists only once the first message is sent. */
  activeConvId: string | null;
  onSelect: (id: string | null) => void;
  onRename: (id: string, title: string) => void;
  onRecolor: (ids: string[], color: ConversationColor | null) => void;
  onArchive: (ids: string[], archived: boolean) => void;
  /** Which archived state the list is showing; the rail does not fetch. */
  scope: ArchiveScope;
  onScopeChange: (scope: ArchiveScope) => void;
  archivedCount: number;
  /** True while a reply is in flight, which freezes actions that would move the user. */
  busy: boolean;
}

/**
 * A project's chats as a rail of cards, replacing the single-select switcher.
 *
 * Mirrors ProjectRail's language deliberately — monogram tile, filter box,
 * count pill, bordered selected row with a colored edge — so the two rails read
 * as one system rather than two components that happen to sit side by side.
 *
 * The selected card's edge takes the chat's own color rather than the brand
 * accent: a colored chat would otherwise show its color on the tile and a
 * different accent on the border, which reads as two unrelated signals.
 */
export function ConversationRail({
  conversations,
  activeConvId,
  onSelect,
  onRename,
  onRecolor,
  onArchive,
  scope,
  onScopeChange,
  archivedCount,
  busy,
}: ConversationRailProps): ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId !== null) renameRef.current?.focus();
  }, [renamingId]);

  const visible = useMemo(
    () => [...conversations].filter(c => matchesFilter(c, query)).sort(byMostRecent),
    [conversations, query]
  );

  const commitRename = (id: string): void => {
    const next = draft.trim();
    const current = conversations.find(c => c.id === id);
    // An empty rename is a no-op, not a way to blank a title: a nameless row
    // cannot be told apart from any other in the list.
    if (next.length > 0 && current !== undefined && next !== conversationLabel(current)) {
      onRename(id, next);
    }
    setRenamingId(null);
  };

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setRenamingId(null);
    }
  };

  const toggle = (id: string): void => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const open = (id: string, additive: boolean): void => {
    // Additive click builds a selection; a plain click opens the chat and drops
    // the selection, which is the ordinary case and must stay one click.
    if (additive) {
      toggle(id);
      return;
    }
    setSelected(new Set());
    setMenuFor(null);
    onSelect(id);
  };

  const recolorTargets = (id: string): string[] =>
    selected.size > 0 && selected.has(id) ? [...selected] : [id];

  return (
    <aside
      className="flex w-[268px] shrink-0 flex-col border-r border-border"
      aria-label="Chats"
      onClick={() => {
        setMenuFor(null);
      }}
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3.5">
        <span className="font-mono text-[10.5px] font-bold tracking-[0.16em] text-text-tertiary">
          CHATS
        </span>
        <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[11px] text-text-secondary">
          {conversations.length}
        </span>
        <button
          type="button"
          onClick={() => {
            setSelected(new Set());
            onSelect(null);
          }}
          disabled={busy || activeConvId === null}
          title={activeConvId === null ? 'Already on a new chat' : 'Start a new chat'}
          className="ml-auto rounded-full border px-2.5 py-[3px] font-mono text-[10px] tracking-[0.1em] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-default disabled:opacity-40"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          + NEW
        </button>
      </div>

      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={e => {
            setQuery(e.target.value);
          }}
          placeholder="Filter chats…"
          aria-label="Filter chats"
          className="w-full rounded-[11px] border bg-[color:var(--surface-elevated)] px-3 py-2 text-[12.5px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          style={{ borderColor: 'var(--border)' }}
        />
      </div>

      <div className="flex gap-1.5 px-3 pb-2.5">
        {SCOPES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              onScopeChange(value);
            }}
            aria-pressed={scope === value}
            className={`rounded-full border px-2.5 py-[3px] font-mono text-[10px] tracking-[0.08em] transition-colors ${
              scope === value ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
            style={{
              borderColor: scope === value ? 'var(--border-bright)' : 'var(--border)',
              background: scope === value ? 'var(--surface-elevated)' : 'transparent',
            }}
          >
            {label}
            {value === 'archived' && archivedCount > 0 ? ` ${String(archivedCount)}` : ''}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-text-tertiary">
            {conversations.length === 0 ? 'No chats yet.' : 'No chats match that filter.'}
          </p>
        ) : null}

        {visible.map(c => {
          const token = colorToken(c.color);
          const isActive = c.id === activeConvId;
          const isSelected = selected.has(c.id);
          return (
            <div
              key={c.id}
              className={`group relative mb-0.5 flex items-start gap-2.5 rounded-[10px] border px-2.5 py-2 transition-colors ${
                c.archived ? 'opacity-55 hover:opacity-100 ' : ''
              }${
                isSelected
                  ? 'bg-[color:color-mix(in_oklch,var(--brand-magenta),transparent_92%)]'
                  : isActive
                    ? 'bg-surface-elevated'
                    : 'hover:bg-surface-hover'
              }`}
              style={{
                borderColor: isActive
                  ? (token ?? 'var(--border-bright)')
                  : isSelected
                    ? 'color-mix(in oklch, var(--brand-magenta), transparent 60%)'
                    : 'transparent',
              }}
              onContextMenu={e => {
                e.preventDefault();
                setMenuFor(c.id);
              }}
            >
              {isActive ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -left-px bottom-2 top-2 w-[3px] rounded-r-[3px]"
                  style={{ background: token ?? 'var(--brand-magenta)' }}
                />
              ) : null}

              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${conversationLabel(c)}`}
                onClick={e => {
                  e.stopPropagation();
                  toggle(c.id);
                }}
                className="mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] text-white"
                style={{
                  borderColor: isSelected ? 'var(--brand-magenta)' : 'var(--border-bright)',
                  background: isSelected ? 'var(--brand-magenta)' : 'transparent',
                }}
              >
                {isSelected ? '✓' : ''}
              </button>

              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border font-mono text-[12px] font-bold"
                style={{
                  background: token ?? 'var(--surface-elevated)',
                  borderColor: token ?? 'var(--border)',
                  color: token !== null ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {conversationMonogram(c)}
              </span>

              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  open(c.id, e.metaKey || e.ctrlKey || e.shiftKey);
                }}
                className="min-w-0 flex-1 text-left"
              >
                {renamingId === c.id ? (
                  <input
                    ref={renameRef}
                    value={draft}
                    onClick={e => {
                      e.stopPropagation();
                    }}
                    onChange={e => {
                      setDraft(e.target.value);
                    }}
                    onKeyDown={e => {
                      onRenameKey(e, c.id);
                    }}
                    onBlur={() => {
                      commitRename(c.id);
                    }}
                    maxLength={255}
                    aria-label="Rename chat"
                    className="w-full rounded border bg-surface px-1 py-0.5 text-[13px] text-text-primary focus:outline-none"
                    style={{ borderColor: 'var(--border-bright)' }}
                  />
                ) : (
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
                      {conversationLabel(c)}
                    </span>
                    {c.lastActivityAt !== null ? (
                      <time
                        dateTime={c.lastActivityAt}
                        className="shrink-0 font-mono text-[10px] text-text-tertiary"
                      >
                        {relativeTime(c.lastActivityAt)}
                      </time>
                    ) : null}
                  </span>
                )}
                {c.brief !== null ? (
                  <span className="mt-[3px] line-clamp-2 block text-[11.5px] leading-[1.5] text-text-secondary">
                    {c.brief}
                  </span>
                ) : null}
                {c.briefUpdatedAt !== null ? (
                  <span
                    className={`mt-[5px] block font-mono text-[10px] ${
                      isBriefStale(c) ? 'text-warning' : 'text-text-tertiary'
                    }`}
                  >
                    {isBriefStale(c)
                      ? `summary ${relativeTime(c.briefUpdatedAt)} — may be stale`
                      : `summary ${relativeTime(c.briefUpdatedAt)}`}
                  </span>
                ) : null}
              </button>

              {menuFor === c.id ? (
                <div
                  role="menu"
                  onClick={e => {
                    e.stopPropagation();
                  }}
                  className="absolute right-2 top-9 z-30 w-[188px] rounded-[11px] border p-[5px] shadow-[0_18px_44px_-18px_rgba(0,0,0,0.85)]"
                  style={{
                    borderColor: 'var(--border-bright)',
                    background: 'var(--surface-hover)',
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDraft(conversationLabel(c));
                      setRenamingId(c.id);
                      setMenuFor(null);
                    }}
                    className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
                  >
                    Rename…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onArchive(recolorTargets(c.id), !c.archived);
                      setSelected(new Set());
                      setMenuFor(null);
                    }}
                    className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
                  >
                    {c.archived ? 'Restore' : 'Archive'}
                  </button>
                  <div className="my-1 h-px bg-border" />
                  <div className="px-2.5 pb-1 font-mono text-[9.5px] tracking-[0.14em] text-text-tertiary">
                    COLOR
                  </div>
                  <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5">
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="No color"
                      title="No color"
                      onClick={() => {
                        onRecolor(recolorTargets(c.id), null);
                        setMenuFor(null);
                      }}
                      className="h-4 w-4 rounded-full border"
                      style={{ borderColor: 'var(--border-bright)' }}
                    />
                    {CONVERSATION_COLORS.map(({ value, label, token: swatch }) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitem"
                        aria-label={label}
                        title={label}
                        onClick={() => {
                          onRecolor(recolorTargets(c.id), value);
                          setMenuFor(null);
                        }}
                        className="h-4 w-4 rounded-full border transition-transform hover:scale-110"
                        style={{
                          background: swatch,
                          borderColor:
                            c.color === value
                              ? 'var(--text-primary)'
                              : 'color-mix(in oklch, black, transparent 70%)',
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {selected.size > 0 ? (
        <div
          className="flex items-center gap-2 border-t bg-surface-elevated px-3 py-2 text-[11.5px]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <span className="font-semibold text-text-primary">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-1.5">
            {CONVERSATION_COLORS.map(({ value, label, token: swatch }) => (
              <button
                key={value}
                type="button"
                aria-label={`${label} for ${String(selected.size)} chats`}
                title={label}
                onClick={() => {
                  onRecolor([...selected], value);
                }}
                className="h-3.5 w-3.5 rounded-full border transition-transform hover:scale-110"
                style={{
                  background: swatch,
                  borderColor: 'color-mix(in oklch, black, transparent 70%)',
                }}
              />
            ))}
            <button
              type="button"
              onClick={() => {
                // Restore when every selected chat is already archived,
                // otherwise archive — one button that always does the
                // non-destructive thing for the current selection.
                const ids = [...selected];
                const allArchived = ids.every(
                  id => conversations.find(c => c.id === id)?.archived === true
                );
                onArchive(ids, !allArchived);
                setSelected(new Set());
              }}
              className="ml-1 rounded-[7px] border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              {[...selected].every(id => conversations.find(c => c.id === id)?.archived === true)
                ? 'Restore'
                : 'Archive'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(new Set());
              }}
              className="rounded-[7px] border px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
