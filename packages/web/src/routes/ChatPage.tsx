import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Search, Plus, Loader2, FolderGit2 } from 'lucide-react';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { ConversationItem } from '@/components/conversations/ConversationItem';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useProject } from '@/contexts/ProjectContext';
import { listConversations, listWorkflowRuns, addCodebase, getCodebaseInput } from '@/lib/api';
import type { CodebaseResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const PANEL_MIN = 220;
const PANEL_MAX = 420;
const PANEL_DEFAULT = 260;
const STORAGE_KEY = 'archon-chat-panel-width';

function getInitialWidth(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = Number(stored);
    if (parsed >= PANEL_MIN && parsed <= PANEL_MAX) return parsed;
  }
  return PANEL_DEFAULT;
}

export function ChatPage(): React.ReactElement {
  const { '*': rawConversationId } = useParams();
  const conversationId = rawConversationId ? decodeURIComponent(rawConversationId) : undefined;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedProjectId, setSelectedProjectId, codebases, isLoadingCodebases } = useProject();

  const [searchQuery, setSearchQuery] = useState('');
  const [width, setWidth] = useState(getInitialWidth);
  const isResizing = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Add-project state
  const [showAddInput, setShowAddInput] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width));
  }, [width]);

  useEffect(() => {
    if (showAddInput) {
      addInputRef.current?.focus();
    }
  }, [showAddInput]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = width;

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const newWidth = Math.min(
          PANEL_MAX,
          Math.max(PANEL_MIN, startWidth + moveEvent.clientX - startX)
        );
        setWidth(newWidth);
      };

      const onMouseUp = (): void => {
        isResizing.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width]
  );

  const { data: conversations } = useQuery({
    queryKey: ['conversations', selectedProjectId],
    queryFn: () => listConversations(selectedProjectId ?? undefined),
    refetchInterval: 10_000,
  });

  const { data: runs } = useQuery({
    queryKey: ['workflow-runs-status'],
    queryFn: () => listWorkflowRuns({ limit: 50 }),
    refetchInterval: 10_000,
  });

  const conversationStatusMap = useMemo((): Map<string, 'running' | 'failed'> => {
    const map = new Map<string, 'running' | 'failed'>();
    if (!runs) return map;
    for (const run of runs) {
      // For web runs, parent_conversation_id is the visible conversation in the sidebar.
      // For CLI runs, conversation_id is the only conversation (no parent/worker split).
      const key = run.parent_conversation_id ?? run.conversation_id;
      if (run.status === 'running') {
        map.set(key, 'running');
      } else if (run.status === 'failed' && !map.has(key)) {
        map.set(key, 'failed');
      }
    }
    return map;
  }, [runs]);

  const codebaseMap = useMemo((): Map<string, CodebaseResponse> => {
    const map = new Map<string, CodebaseResponse>();
    if (codebases) {
      for (const cb of codebases) {
        map.set(cb.id, cb);
      }
    }
    return map;
  }, [codebases]);

  const filtered = useMemo(
    () =>
      conversations?.filter(conv => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(query);
      }),
    [conversations, searchQuery]
  );

  const handleNewChat = useCallback((): void => {
    navigate('/chat');
  }, [navigate]);

  const handleAddSubmit = useCallback((): void => {
    const trimmed = addValue.trim();
    if (!trimmed || addLoading) return;

    setAddLoading(true);
    setAddError(null);

    void addCodebase(getCodebaseInput(trimmed))
      .then(codebase => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        setSelectedProjectId(codebase.id);
        setShowAddInput(false);
        setAddValue('');
        setAddError(null);
      })
      .catch((err: Error) => {
        setAddError(err.message);
      })
      .finally(() => {
        setAddLoading(false);
      });
  }, [addValue, addLoading, queryClient, setSelectedProjectId]);

  const handleAddKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        handleAddSubmit();
      } else if (e.key === 'Escape') {
        setShowAddInput(false);
        setAddValue('');
        setAddError(null);
      }
    },
    [handleAddSubmit]
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left panel */}
      <div
        className="relative flex h-full flex-col border-r border-border bg-surface overflow-hidden"
        style={{ width: `${String(width)}px`, flexShrink: 0 }}
      >
        {/* New Chat button */}
        <div className="px-3 pt-3 pb-2">
          <button
            onClick={handleNewChat}
            className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-accent-hover transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0" />
            {t('chat.newChat')}
          </button>
        </div>

        {/* Project filter */}
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              {t('chat.project')}
            </span>
            <button
              onClick={(): void => {
                setShowAddInput(prev => !prev);
                setAddError(null);
                setAddValue('');
              }}
              className="p-1 rounded hover:bg-surface-elevated transition-colors"
              title={t('sidebar.addProject')}
            >
              <Plus className="h-3.5 w-3.5 text-text-tertiary hover:text-primary" />
            </button>
          </div>

          {showAddInput && (
            <div className="mb-2">
              <div className="flex items-center gap-1">
                <input
                  ref={addInputRef}
                  value={addValue}
                  onChange={(e): void => {
                    setAddValue(e.target.value);
                  }}
                  onKeyDown={handleAddKeyDown}
                  onBlur={(): void => {
                    if (!addValue.trim() && !addError) {
                      setShowAddInput(false);
                    }
                  }}
                  placeholder={t('sidebar.projectInputPlaceholder')}
                  disabled={addLoading}
                  className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
                />
                {addLoading && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                )}
              </div>
              {addError && <p className="mt-1 text-[10px] text-error line-clamp-2">{addError}</p>}
            </div>
          )}

          {isLoadingCodebases ? (
            <div className="flex items-center justify-center py-2">
              <span className="text-xs text-text-tertiary">{t('common.loading')}</span>
            </div>
          ) : (
            <select
              value={selectedProjectId ?? ''}
              onChange={(e): void => {
                setSelectedProjectId(e.target.value || null);
              }}
              className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-primary focus:border-primary focus:outline-none"
            >
              <option value="">{t('dashboard.allProjects')}</option>
              {codebases?.map(cb => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <Separator className="bg-border" />

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-tertiary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e): void => {
                setSearchQuery(e.target.value);
              }}
              placeholder={t('chat.search')}
              className="w-full rounded-md border border-border bg-surface-elevated py-1.5 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* Conversation list */}
        <ScrollArea className="flex-1 min-h-0 px-2 pb-2">
          <div className="flex flex-col gap-0.5">
            {filtered && filtered.length > 0 ? (
              filtered.map(conv => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  projectName={
                    conv.codebase_id ? codebaseMap.get(conv.codebase_id)?.name : undefined
                  }
                  status={conversationStatusMap.get(conv.id) ?? 'idle'}
                />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-8 px-4">
                <FolderGit2 className="h-8 w-8 text-text-tertiary" />
                <span
                  className={cn(
                    'text-xs text-text-tertiary text-center',
                    conversations && conversations.length > 0 ? '' : ''
                  )}
                >
                  {conversations && conversations.length > 0
                    ? t('chat.noMatchingConversations')
                    : t('chat.noConversationsYet')}
                </span>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Resize handle */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-border/50 hover:bg-primary/40 transition-colors"
        />
      </div>

      {/* Right panel - chat interface */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <ChatInterface key={conversationId ?? 'new'} conversationId={conversationId ?? 'new'} />
      </div>
    </div>
  );
}
