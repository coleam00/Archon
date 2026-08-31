import { useState, type ReactElement } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { relativeTime } from '../lib/format';
import type { ConversationSummary } from '../primitives/conversation';

/**
 * Properties for the ChatHistoryPanel component.
 */
export interface ChatHistoryPanelProps {
  /** Array of project conversation summaries sorted by activity. */
  conversations: ConversationSummary[];
  /** Currently active/selected conversation platform ID. */
  activeConvId: string | null;
  /** Callback fired when user selects a conversation row. */
  onSelectConversation: (convId: string) => void;
  /** Callback fired when user clicks "+ New Chat". */
  onNewChat: () => void;
  /** Optional callback to rename a conversation. */
  onRenameConversation?: (convId: string, newTitle: string) => Promise<void>;
  /** Optional callback to delete a conversation. */
  onDeleteConversation?: (convId: string) => Promise<void>;
}

/**
 * Narrow right-hand chat history index for the console chat route.
 * Shows project-scoped chat sessions sorted by last activity with a "+ New Chat" button,
 * inline conversation renaming, and inline deletion confirmation.
 */
export function ChatHistoryPanel({
  conversations,
  activeConvId,
  onSelectConversation,
  onNewChat,
  onRenameConversation,
  onDeleteConversation,
}: ChatHistoryPanelProps): ReactElement {
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDeleteConvId, setConfirmDeleteConvId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleStartRename = (c: ConversationSummary): void => {
    setConfirmDeleteConvId(null);
    setEditingConvId(c.id);
    setEditTitle(c.title?.trim() || 'Untitled Chat');
  };

  const handleCancelRename = (): void => {
    setEditingConvId(null);
    setEditTitle('');
  };

  const handleSaveRename = async (convId: string): Promise<void> => {
    const trimmed = editTitle.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (onRenameConversation) {
        await onRenameConversation(convId, trimmed);
      }
      setEditingConvId(null);
    } catch (err) {
      console.error('Failed to update conversation title:', err);
      // Keep edit mode open on failure
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartDelete = (convId: string): void => {
    setEditingConvId(null);
    setConfirmDeleteConvId(convId);
  };

  const handleCancelDelete = (): void => {
    setConfirmDeleteConvId(null);
  };

  const handleConfirmDelete = async (convId: string): Promise<void> => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (onDeleteConversation) {
        await onDeleteConversation(convId);
      }
      setConfirmDeleteConvId(null);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      // Keep confirm state open on failure
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <aside
      aria-label="Chat history"
      className="flex h-full w-64 shrink-0 flex-col border-l border-border bg-surface text-text-primary"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
          Chats
        </h2>
        <button
          type="button"
          onClick={onNewChat}
          className="flex items-center gap-1.5 rounded-[7px] border border-border bg-surface-elevated px-2.5 py-1 text-[11.5px] font-medium text-text-primary transition-colors hover:border-border-bright hover:bg-surface-hover hover:text-text-primary active:scale-[0.98]"
        >
          <Plus size={13} className="text-accent" />
          <span>New Chat</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-center font-mono text-[11px] text-text-tertiary">
            No past chats
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {conversations.map(c => {
              const active = c.id === activeConvId;
              const title = c.title?.trim() || 'Untitled Chat';
              const time = c.lastActivityAt ? relativeTime(c.lastActivityAt) : null;

              if (confirmDeleteConvId === c.id) {
                return (
                  <li key={c.id}>
                    <div
                      className={`flex w-full flex-col gap-1.5 rounded-[8px] p-2 text-left border ${
                        active
                          ? 'border-border-bright bg-surface-elevated text-text-primary'
                          : 'border-border bg-surface-hover text-text-primary'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 text-[11px] font-medium text-error">
                        <span>Delete chat?</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={e => {
                              e.stopPropagation();
                              void handleConfirmDelete(c.id);
                            }}
                            className="rounded bg-error px-1.5 py-0.5 text-[11px] font-semibold text-white hover:bg-error/90 disabled:opacity-50"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={e => {
                              e.stopPropagation();
                              handleCancelDelete();
                            }}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              }

              if (editingConvId === c.id) {
                return (
                  <li key={c.id}>
                    <div
                      className={`flex w-full items-center gap-1 rounded-[8px] p-1.5 border ${
                        active
                          ? 'border-border-bright bg-surface-elevated text-text-primary'
                          : 'border-border bg-surface-hover text-text-primary'
                      }`}
                      onClick={e => {
                        e.stopPropagation();
                      }}
                    >
                      <input
                        type="text"
                        autoFocus
                        disabled={isSubmitting}
                        value={editTitle}
                        onChange={e => {
                          setEditTitle(e.target.value);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleSaveRename(c.id);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            handleCancelRename();
                          }
                        }}
                        className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[12px] text-text-primary focus:border-border-bright focus:outline-none"
                      />
                      <button
                        type="button"
                        title="Save title"
                        aria-label="Save title"
                        disabled={isSubmitting || !editTitle.trim()}
                        onClick={e => {
                          e.stopPropagation();
                          void handleSaveRename(c.id);
                        }}
                        className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-50"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        type="button"
                        title="Cancel rename"
                        aria-label="Cancel rename"
                        disabled={isSubmitting}
                        onClick={e => {
                          e.stopPropagation();
                          handleCancelRename();
                        }}
                        className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-50"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li key={c.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onSelectConversation(c.id);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectConversation(c.id);
                      }
                    }}
                    className={`group relative flex w-full cursor-pointer items-center justify-between rounded-[8px] p-2.5 text-left transition-colors ${
                      active
                        ? 'border border-border-bright bg-surface-elevated text-text-primary'
                        : 'border border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    }`}
                  >
                    {active ? (
                      <span
                        aria-hidden
                        className="brand-bar absolute inset-y-1 left-0 w-1 rounded-r-full"
                      />
                    ) : null}
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="w-full truncate text-[12.5px] font-medium leading-tight">
                        {title}
                      </span>
                      {time !== null ? (
                        <span className="font-mono text-[10.5px] text-text-tertiary">{time}</span>
                      ) : null}
                    </div>
                    <div className="ml-1 hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                      {onRenameConversation !== undefined ? (
                        <button
                          type="button"
                          title="Rename chat"
                          aria-label={`Rename ${title}`}
                          onClick={e => {
                            e.stopPropagation();
                            handleStartRename(c);
                          }}
                          className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                        >
                          <Pencil size={12} />
                        </button>
                      ) : null}
                      {onDeleteConversation !== undefined ? (
                        <button
                          type="button"
                          title="Delete chat"
                          aria-label={`Delete ${title}`}
                          onClick={e => {
                            e.stopPropagation();
                            handleStartDelete(c.id);
                          }}
                          className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-error"
                        >
                          <Trash2 size={12} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
