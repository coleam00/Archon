import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { listConversations, listWorkflowRuns } from '@/lib/api';
import type { CodebaseResponse } from '@/lib/api';
import { ConversationItem } from '@/components/conversations/ConversationItem';
import { useProject } from '@/contexts/ProjectContext';

interface AllConversationsViewProps {
  searchQuery: string;
}

export function AllConversationsView({
  searchQuery,
}: AllConversationsViewProps): React.ReactElement {
  const navigate = useNavigate();
  const { codebases } = useProject();

  const { data: conversations, isError: isErrorConversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => listConversations(),
    refetchInterval: 10_000,
  });

  const { data: runs, isError: isErrorRuns } = useQuery({
    queryKey: ['workflow-runs-status'],
    queryFn: () => listWorkflowRuns({ limit: 50 }),
    refetchInterval: 10_000,
  });

  const conversationStatusMap = useMemo((): Map<string, 'running' | 'failed'> => {
    const map = new Map<string, 'running' | 'failed'>();
    if (!runs || isErrorRuns) return map; // skip silently on error — status badges are secondary UI
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
  }, [runs, isErrorRuns]);

  const codebaseMap = new Map<string, CodebaseResponse>();
  if (codebases) {
    for (const cb of codebases) {
      codebaseMap.set(cb.id, cb);
    }
  }

  const handleNewChat = (): void => {
    navigate('/chat');
  };

  const filtered = conversations?.filter(conv => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(query);
  });

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={handleNewChat}
        className="mx-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-accent-hover transition-colors"
      >
        New Chat
      </button>

      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          All Conversations
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {isErrorConversations ? (
            <span className="px-1 text-xs text-error">Failed to load — retrying</span>
          ) : filtered && filtered.length > 0 ? (
            filtered.map(conv => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                projectName={conv.codebase_id ? codebaseMap.get(conv.codebase_id)?.name : undefined}
                status={conversationStatusMap.get(conv.id) ?? 'idle'}
              />
            ))
          ) : (
            <span className="px-1 text-xs text-text-tertiary">
              {conversations && conversations.length > 0
                ? 'No matching conversations'
                : 'No conversations yet — start a new chat!'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
