import { useState, useRef, useCallback } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationResponse } from '@/lib/api';
import { deleteConversation, updateConversation } from '@/lib/api';
import { platformLabel, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConversationItemProps {
  conversation: ConversationResponse;
  badge?: number;
  projectName?: string;
  status?: 'idle' | 'running' | 'failed';
}

export function ConversationItem({
  conversation,
  badge,
  projectName,
  status = 'idle',
}: ConversationItemProps): React.ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams<{ conversationId: string }>();

  const displayName = conversation.title
    ? conversation.title.length > 30
      ? conversation.title.slice(0, 30) + '...'
      : conversation.title
    : t('chat.untitledConversation');

  const lastActivity = conversation.last_activity_at
    ? new Date(
        conversation.last_activity_at.endsWith('Z')
          ? conversation.last_activity_at
          : conversation.last_activity_at + 'Z'
      ).toLocaleString('ko-KR', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : t('chat.noActivity');

  const handleDelete = useCallback((): void => {
    setDeleteError(null);
    void deleteConversation(conversation.platform_conversation_id)
      .then(() => {
        setDeleteDialogOpen(false);
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        if (params.conversationId === conversation.platform_conversation_id) {
          void navigate('/');
        }
      })
      .catch((err: unknown) => {
        setDeleteError(err instanceof Error ? err.message : t('chat.deleteConversationFailed'));
        setDeleteDialogOpen(true);
      });
  }, [conversation.platform_conversation_id, queryClient, navigate, params.conversationId]);

  const handleRenameSubmit = useCallback((): void => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      setRenameError(null);
      void updateConversation(conversation.platform_conversation_id, { title: trimmed })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        })
        .catch((err: unknown) => {
          setRenameError(err instanceof Error ? err.message : t('chat.renameConversationFailed'));
          setIsEditing(true);
        });
    } else {
      setRenameError(null);
    }
    setIsEditing(false);
  }, [editValue, conversation.id, conversation.title, queryClient]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setRenameError(null);
        setIsEditing(false);
      }
    },
    [handleRenameSubmit]
  );

  return (
    <NavLink
      to={`/chat/${encodeURIComponent(conversation.platform_conversation_id)}`}
      className={({ isActive }): string =>
        cn(
          'group relative flex min-h-[2.75rem] w-full items-start gap-2 rounded-md px-3 py-2 transition-colors duration-150',
          isActive ? 'border-l-2 border-l-primary bg-accent-muted' : 'hover:bg-surface-elevated'
        )
      }
    >
      <div
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          status === 'running' && 'bg-primary animate-pulse',
          status === 'failed' && 'bg-destructive',
          status === 'idle' && 'bg-text-tertiary'
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e): void => {
              setEditValue(e.target.value);
            }}
            onBlur={handleRenameSubmit}
            onKeyDown={handleKeyDown}
            onClick={(e): void => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="w-full bg-transparent text-sm text-text-primary outline-none border-b border-primary"
          />
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="truncate text-sm text-text-primary"
              title={conversation.title ?? t('chat.untitledConversation')}
            >
              {displayName}
            </span>
            {conversation.platform_type !== 'web' && (
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-tertiary bg-surface-secondary rounded px-1 py-0.5 shrink-0">
                {platformLabel(conversation.platform_type)}
              </span>
            )}
          </div>
        )}
        {renameError && <span className="text-[10px] text-error">{renameError}</span>}
        <span className="truncate text-[11px] text-text-tertiary">{lastActivity}</span>
        {projectName && (
          <span className="truncate text-[10px] text-text-tertiary">{projectName}</span>
        )}
      </div>
      {!isEditing && (
        <>
          <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
            <button
              onClick={(e): void => {
                e.preventDefault();
                e.stopPropagation();
                setEditValue(conversation.title ?? '');
                setRenameError(null);
                setIsEditing(true);
                setTimeout(() => {
                  inputRef.current?.focus();
                  inputRef.current?.select();
                }, 0);
              }}
              className="p-1 rounded hover:bg-surface-elevated"
              title={t('chat.renameConversation')}
            >
              <Pencil className="h-3.5 w-3.5 text-text-tertiary hover:text-primary" />
            </button>
            <button
              onClick={(e): void => {
                e.preventDefault();
                e.stopPropagation();
                setDeleteError(null);
                setDeleteDialogOpen(true);
              }}
              className="p-1 rounded hover:bg-surface-elevated"
              title={t('chat.deleteConversation')}
            >
              <Trash2 className="h-3.5 w-3.5 text-text-tertiary hover:text-error" />
            </button>
          </div>
          <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('chat.deleteConversationTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('chat.deleteConversationDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {deleteError && <p className="text-sm text-error px-1">{deleteError}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {badge !== undefined && badge > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-error text-[10px] font-semibold text-white px-1">
          {badge > 99 ? '99+' : String(badge)}
        </span>
      )}
    </NavLink>
  );
}
