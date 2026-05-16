import { useState, useRef, useCallback } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationResponse } from '@/lib/api';
import { deleteConversation, updateConversation } from '@/lib/api';
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
    : 'Untitled conversation';

  const lastActivity = conversation.last_activity_at
    ? new Date(
        conversation.last_activity_at.endsWith('Z')
          ? conversation.last_activity_at
          : conversation.last_activity_at + 'Z'
      ).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'No activity';

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
        setDeleteError(err instanceof Error ? err.message : 'Failed to delete conversation');
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
          setRenameError(err instanceof Error ? err.message : 'Failed to rename conversation');
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
          'group relative flex min-h-[2.75rem] w-full items-start gap-2 border-[3px] px-3 py-2 transition-colors duration-150',
          isActive
            ? 'border-black bg-black'
            : 'border-transparent hover:border-black hover:bg-[#F0F0F0]'
        )
      }
    >
      {({ isActive }): React.ReactNode => (
        <>
          <div
            className={cn(
              'h-2 w-2 shrink-0',
              status === 'running' && 'bg-[#FFA500] animate-pulse',
              status === 'failed' && 'bg-[#FF0000]',
              status === 'idle' && (isActive ? 'bg-[#CCCCCC]' : 'bg-[#666666]')
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
                className={cn(
                  'w-full bg-transparent text-sm outline-none border-b-2',
                  isActive ? 'text-white border-white' : 'text-black border-black'
                )}
              />
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={cn(
                    'truncate text-sm font-semibold',
                    isActive ? 'text-white' : 'text-black'
                  )}
                  title={conversation.title ?? 'Untitled conversation'}
                >
                  {displayName}
                </span>
                {conversation.platform_type !== 'web' && (
                  <span
                    className={cn(
                      'text-[10px] font-semibold uppercase tracking-wider border px-1.5 py-0.5 shrink-0',
                      isActive
                        ? 'text-[#CCCCCC] border-[#666666]'
                        : 'text-[#666666] border-[#CCCCCC]'
                    )}
                  >
                    {conversation.platform_type}
                  </span>
                )}
              </div>
            )}
            {renameError && <span className="text-[10px] text-[#FF0000]">{renameError}</span>}
            <span
              className={cn('truncate text-[11px]', isActive ? 'text-[#CCCCCC]' : 'text-[#666666]')}
            >
              {lastActivity}
            </span>
            {projectName && (
              <span
                className={cn(
                  'truncate text-[10px]',
                  isActive ? 'text-[#CCCCCC]' : 'text-[#666666]'
                )}
              >
                {projectName}
              </span>
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
                  className={cn(
                    'p-1 border border-transparent transition-colors',
                    isActive ? 'hover:border-white' : 'hover:border-black'
                  )}
                  title="Rename conversation"
                >
                  <Pencil
                    className={cn(
                      'h-3.5 w-3.5',
                      isActive
                        ? 'text-[#CCCCCC] hover:text-white'
                        : 'text-[#666666] hover:text-black'
                    )}
                  />
                </button>
                <button
                  onClick={(e): void => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeleteError(null);
                    setDeleteDialogOpen(true);
                  }}
                  className={cn(
                    'p-1 border border-transparent transition-colors',
                    isActive ? 'hover:border-white' : 'hover:border-black'
                  )}
                  title="Delete conversation"
                >
                  <Trash2
                    className={cn(
                      'h-3.5 w-3.5 hover:text-[#FF0000]',
                      isActive ? 'text-[#CCCCCC]' : 'text-[#666666]'
                    )}
                  />
                </button>
              </div>
              <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete this conversation and its messages. This action
                      cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {deleteError && <p className="text-sm text-[#FF0000] px-1">{deleteError}</p>}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
          {badge !== undefined && badge > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center bg-[#FF0000] text-[10px] font-semibold text-white px-1">
              {badge > 99 ? '99+' : String(badge)}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
