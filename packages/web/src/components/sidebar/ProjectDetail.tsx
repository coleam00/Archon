import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { listConversations, listWorkflowRuns, getCodebaseEnvironments } from '@/lib/api';
import type { WorkflowRunResponse, IsolationEnvironment } from '@/lib/api';
import { ConversationItem } from '@/components/conversations/ConversationItem';
import { WorkflowInvoker } from '@/components/sidebar/WorkflowInvoker';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ProjectDetailProps {
  codebaseId: string;
  projectName: string;
  repositoryUrl?: string | null;
  searchQuery: string;
}

function RunStatusBadge({ status }: { status: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold border-[2px]',
        status === 'running' && 'border-black bg-black text-white',
        status === 'completed' && 'border-[#008000] text-[#008000] bg-white',
        status === 'failed' && 'border-[#FF0000] text-[#FF0000] bg-white',
        status === 'cancelled' && 'border-[#CCCCCC] text-[#666666] bg-white'
      )}
    >
      {status}
    </span>
  );
}

export function ProjectDetail({
  codebaseId,
  projectName,
  repositoryUrl,
  searchQuery,
}: ProjectDetailProps): React.ReactElement {
  const navigate = useNavigate();

  const { data: conversations, isError: isErrorConversations } = useQuery({
    queryKey: ['conversations', { codebaseId }],
    queryFn: () => listConversations(codebaseId),
    refetchInterval: 10_000,
  });

  const { data: runs, isError: isErrorRuns } = useQuery({
    queryKey: ['workflow-runs', { codebaseId }],
    queryFn: () => listWorkflowRuns({ codebaseId, limit: 20 }),
    refetchInterval: 10_000,
  });

  const { data: environments, isError: isErrorEnvironments } = useQuery({
    queryKey: ['environments', { codebaseId }],
    queryFn: () => getCodebaseEnvironments(codebaseId),
    refetchInterval: 10_000,
  });

  const activeEnvironments = useMemo(
    () => environments?.filter((e: IsolationEnvironment) => e.status === 'active') ?? [],
    [environments]
  );

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

  const handleNewChat = (): void => {
    navigate('/chat');
  };

  const handleRunClick = (run: WorkflowRunResponse): void => {
    navigate(`/workflows/runs/${run.id}`);
  };

  // Filter conversations by search
  const filteredConversations = conversations?.filter(conv => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(query);
  });

  // Filter and sort runs by search and status
  const sortedRuns = runs
    ?.filter(run => {
      if (!searchQuery) return true;
      return run.workflow_name.toLowerCase().includes(searchQuery.toLowerCase());
    })
    .sort((a, b) => {
      const priority: Record<string, number> = { failed: 0, running: 1, completed: 2 };
      return (priority[a.status] ?? 3) - (priority[b.status] ?? 3);
    });

  return (
    <div className="min-w-0 flex flex-col gap-3">
      <div className="px-1">
        <h3 className="text-sm font-semibold text-black truncate">{projectName}</h3>
        {repositoryUrl && (
          <p className="text-[10px] text-[#666666] truncate font-mono">{repositoryUrl}</p>
        )}
      </div>

      <button
        onClick={handleNewChat}
        className="mx-1 border-[3px] border-black bg-black px-3 py-2 text-xs font-semibold text-white hover:bg-white hover:text-black transition-colors"
      >
        New Chat
      </button>

      <WorkflowInvoker codebaseId={codebaseId} />

      {/* Conversations section */}
      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[#666666]">
          Conversations
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {isErrorConversations ? (
            <span className="px-1 text-xs text-[#FF0000]">Failed to load — retrying</span>
          ) : filteredConversations && filteredConversations.length > 0 ? (
            filteredConversations.map(conv => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                status={conversationStatusMap.get(conv.id) ?? 'idle'}
              />
            ))
          ) : (
            <span className="px-1 text-xs text-[#666666]">No conversations</span>
          )}
        </div>
      </div>

      {/* Workflow runs section */}
      <div>
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[#666666]">
          Workflow Runs
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {isErrorRuns ? (
            <span className="px-1 text-xs text-[#FF0000]">Failed to load — retrying</span>
          ) : sortedRuns && sortedRuns.length > 0 ? (
            sortedRuns.map(run => (
              <button
                key={run.id}
                onClick={(): void => {
                  handleRunClick(run);
                }}
                className="flex items-center gap-2 px-2 py-2 border-[2px] border-black text-xs hover:bg-black hover:text-white transition-colors w-full text-left"
              >
                <span className="truncate flex-1 text-sm font-semibold">{run.workflow_name}</span>
                <RunStatusBadge status={run.status} />
                <span className="text-[10px] text-[#666666] shrink-0 font-mono">
                  {formatDuration(run.started_at, run.completed_at)}
                </span>
              </button>
            ))
          ) : (
            <span className="px-1 text-xs text-[#666666]">No workflow runs</span>
          )}
        </div>
      </div>

      {/* Active worktrees section */}
      {(isErrorEnvironments || activeEnvironments.length > 0) && (
        <div>
          <span className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[#666666]">
            Active Worktrees{!isErrorEnvironments && ` (${String(activeEnvironments.length)})`}
          </span>
          <div className="mt-1 flex flex-col gap-0.5">
            {isErrorEnvironments ? (
              <span className="px-1 text-xs text-[#FF0000]">Failed to load — retrying</span>
            ) : (
              activeEnvironments.map((env: IsolationEnvironment) => (
                <div
                  key={env.id}
                  className="flex items-center justify-between gap-2 border-[2px] border-black px-2 py-1.5 text-xs"
                >
                  <span className="truncate font-mono text-[11px] text-black">
                    {env.branch_name}
                  </span>
                  <span className="shrink-0 text-[10px] text-[#666666]">
                    {env.days_since_activity === 0
                      ? 'today'
                      : `${String(env.days_since_activity)}d ago`}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
