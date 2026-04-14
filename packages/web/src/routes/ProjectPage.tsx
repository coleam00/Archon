import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  FolderGit2,
  MoreHorizontal,
  Plus,
  MessageSquare,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { listConversations, listWorkflows, deleteCodebase, createConversation } from '@/lib/api';
import type { ConversationResponse, WorkflowListEntry } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';
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

// ---------------------------------------------------------------------------
// localStorage helpers for per-project workflow selection
// ---------------------------------------------------------------------------

function workflowStorageKey(projectId: string): string {
  return `archon-project-workflows-${projectId}`;
}

function getStoredWorkflows(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(workflowStorageKey(projectId));
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function persistWorkflows(projectId: string, names: string[]): void {
  try {
    localStorage.setItem(workflowStorageKey(projectId), JSON.stringify(names));
  } catch {
    // best-effort — ignore quota errors
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'chats' | 'settings';

interface WorkflowGroup {
  prefix: string;
  workflows: WorkflowListEntry[];
}

// ---------------------------------------------------------------------------
// Grouping helper
// ---------------------------------------------------------------------------

function groupByPrefix(workflows: WorkflowListEntry[]): WorkflowGroup[] {
  const map = new Map<string, WorkflowListEntry[]>();
  for (const wf of workflows) {
    const dashIdx = wf.workflow.name.indexOf('-');
    const prefix = dashIdx !== -1 ? wf.workflow.name.slice(0, dashIdx) : 'other';
    const existing = map.get(prefix);
    if (existing) {
      existing.push(wf);
    } else {
      map.set(prefix, [wf]);
    }
  }
  const groups: WorkflowGroup[] = [];
  for (const [prefix, wfs] of map) {
    groups.push({ prefix, workflows: wfs });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ConversationRowProps {
  conversation: ConversationResponse;
  onClick: () => void;
}

function ConversationRow({ conversation, onClick }: ConversationRowProps): React.ReactElement {
  const title = conversation.title ?? 'Untitled conversation';
  const lastActivity = conversation.last_activity_at
    ? new Date(
        conversation.last_activity_at.endsWith('Z')
          ? conversation.last_activity_at
          : `${conversation.last_activity_at}Z`
      ).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'No activity';

  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 border-b border-border px-4 py-3.5 text-left hover:bg-surface-elevated transition-colors w-full"
    >
      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-text-primary">{title}</span>
        <span className="text-xs text-text-tertiary">{lastActivity}</span>
      </div>
    </button>
  );
}

interface GroupCheckboxProps {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}

function GroupCheckbox({
  checked,
  indeterminate,
  onChange,
}: GroupCheckboxProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-4 w-4 accent-primary"
    />
  );
}

function SourceBadge({ source }: { source: string }): React.ReactElement {
  if (source === 'bundled') {
    return (
      <span
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold bg-violet-500/15 text-violet-500"
        title="Built-in default"
      >
        D
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-surface-elevated text-[9px] font-bold text-text-tertiary"
      title="Local to this project"
    >
      L
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProjectPage(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { codebases, setSelectedProjectId } = useProject();

  const [activeTab, setActiveTab] = useState<Tab>('chats');
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [enabledWorkflows, setEnabledWorkflows] = useState<string[]>(() =>
    projectId ? getStoredWorkflows(projectId) : []
  );

  const project = codebases?.find(cb => cb.id === projectId);

  // Conversations for this project
  const { data: conversations, isLoading: loadingConvs } = useQuery({
    queryKey: ['conversations', { codebaseId: projectId }],
    queryFn: () => listConversations(projectId),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });

  // Workflows (only fetch when Settings tab is active)
  const { data: workflows, isLoading: loadingWorkflows } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => listWorkflows(),
    enabled: activeTab === 'settings',
  });

  const sortedConversations = [...(conversations ?? [])].sort((a, b) => {
    const aTime = a.last_activity_at ?? a.created_at;
    const bTime = b.last_activity_at ?? b.created_at;
    return bTime.localeCompare(aTime);
  });

  // Groups sorted: selections first, 'other' last, then alphabetical
  const sortedGroups = useMemo((): WorkflowGroup[] => {
    if (!workflows) return [];
    const groups = groupByPrefix(workflows);
    return groups.sort((a, b) => {
      if (a.prefix === 'other') return 1;
      if (b.prefix === 'other') return -1;
      const aHasSelected = a.workflows.some(wf => enabledWorkflows.includes(wf.workflow.name));
      const bHasSelected = b.workflows.some(wf => enabledWorkflows.includes(wf.workflow.name));
      if (aHasSelected && !bHasSelected) return -1;
      if (!aHasSelected && bHasSelected) return 1;
      return a.prefix.localeCompare(b.prefix);
    });
  }, [workflows, enabledWorkflows]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleNewChat = useCallback((): void => {
    if (!projectId || creatingChat) return;
    setCreatingChat(true);
    void createConversation(projectId)
      .then(result => {
        const convId = result.conversationId ?? result.id;
        navigate(`/chat/${encodeURIComponent(convId)}`);
      })
      .catch((err: Error) => {
        console.error('[ProjectPage] Failed to create conversation', err);
      })
      .finally(() => {
        setCreatingChat(false);
      });
  }, [projectId, creatingChat, navigate]);

  const handleDeleteProject = useCallback((): void => {
    if (!projectId) return;
    setDeleteError(null);
    void deleteCodebase(projectId)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        setSelectedProjectId(null);
        navigate('/');
      })
      .catch((err: Error) => {
        setDeleteError(err.message);
      });
  }, [projectId, queryClient, setSelectedProjectId, navigate]);

  const handleWorkflowToggle = useCallback(
    (name: string): void => {
      if (!projectId) return;
      setEnabledWorkflows(prev => {
        const next = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
        persistWorkflows(projectId, next);
        return next;
      });
    },
    [projectId]
  );

  const handleGroupToggleAll = useCallback(
    (groupWorkflows: WorkflowListEntry[]): void => {
      if (!projectId) return;
      const groupNames = groupWorkflows.map(wf => wf.workflow.name);
      const allEnabled = groupNames.every(n => enabledWorkflows.includes(n));
      setEnabledWorkflows(prev => {
        const next = allEnabled
          ? prev.filter(n => !groupNames.includes(n))
          : [...new Set([...prev, ...groupNames])];
        persistWorkflows(projectId, next);
        return next;
      });
    },
    [projectId, enabledWorkflows]
  );

  const toggleGroupCollapsed = useCallback((prefix: string): void => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Guard
  // ---------------------------------------------------------------------------

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-text-tertiary">Project not found</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* ── Top bar ── */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border shrink-0 bg-surface">
        <button
          onClick={(): void => {
            navigate('/');
          }}
          className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="flex-1 text-center text-sm font-semibold text-text-primary truncate">
          {project?.name ?? 'Project'}
        </h1>
        {/* ⋯ menu */}
        <div className="relative">
          <button
            onClick={(): void => {
              setMenuOpen(prev => !prev);
            }}
            className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
            aria-label="Project options"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={(): void => {
                  setMenuOpen(false);
                }}
                aria-hidden="true"
              />
              <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg border border-border bg-surface shadow-lg py-1">
                <button
                  onClick={(): void => {
                    setMenuOpen(false);
                    setDeleteDialogOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-error hover:bg-surface-elevated transition-colors"
                >
                  Delete project
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Project header ── */}
      <div className="flex flex-col items-center gap-3 px-4 py-3 border-b border-border shrink-0 bg-surface">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-muted">
          <FolderGit2 className="h-5 w-5 text-primary" />
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-text-primary">{project?.name ?? 'Project'}</h2>
          {project?.repository_url && (
            <p className="mt-0.5 text-xs text-text-tertiary truncate max-w-[280px]">
              {project.repository_url}
            </p>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-border shrink-0 bg-surface">
        {(['chats', 'settings'] as Tab[]).map(tab => (
          <button
            key={tab}
            onClick={(): void => {
              setActiveTab(tab);
            }}
            className={cn(
              'flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
          >
            {tab === 'chats' ? 'Chats' : 'Settings'}
          </button>
        ))}
      </div>

      {/* ── Tab content (scrollable) ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Chats tab */}
        {activeTab === 'chats' && (
          <div className="flex flex-col">
            {loadingConvs ? (
              <div className="flex items-center justify-center py-12">
                <span className="text-sm text-text-tertiary">Loading...</span>
              </div>
            ) : sortedConversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 px-4">
                <MessageSquare className="h-10 w-10 text-text-tertiary" />
                <p className="text-sm text-text-tertiary text-center">
                  No chats yet — start a new one
                </p>
              </div>
            ) : (
              sortedConversations.map(conv => (
                <ConversationRow
                  key={conv.id}
                  conversation={conv}
                  onClick={(): void => {
                    navigate(`/chat/${encodeURIComponent(conv.platform_conversation_id)}`);
                  }}
                />
              ))
            )}

            {/* New chat button — only visible in the Chats tab */}
            <div className="sticky bottom-0 border-t border-border bg-surface px-4 py-3">
              <button
                onClick={handleNewChat}
                disabled={creatingChat}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {creatingChat ? 'Creating...' : 'New chat'}
              </button>
            </div>
          </div>
        )}

        {/* Settings tab */}
        {activeTab === 'settings' && (
          <div className="flex flex-col gap-6 px-4 py-5">
            {/* Project settings card */}
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Project settings
              </h3>
              <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-elevated p-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-text-tertiary">Name</span>
                  <span className="text-sm font-medium text-text-primary">
                    {project?.name ?? '—'}
                  </span>
                </div>
                <div className="h-px bg-border" />
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-text-tertiary">Repository URL</span>
                  <span className="break-all font-mono text-sm text-text-secondary">
                    {project?.repository_url ?? '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Available workflows */}
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Available workflows
              </h3>
              <p className="mb-3 text-[11px] italic text-text-tertiary">
                Selection is stored locally
              </p>
              {loadingWorkflows ? (
                <span className="text-xs text-text-tertiary">Loading...</span>
              ) : !workflows || workflows.length === 0 ? (
                <span className="text-xs text-text-tertiary">No workflows available</span>
              ) : (
                <div className="flex flex-col gap-3">
                  {sortedGroups.map(group => {
                    const isCollapsed = collapsedGroups.has(group.prefix);
                    const groupNames = group.workflows.map(wf => wf.workflow.name);
                    const checkedCount = groupNames.filter(n =>
                      enabledWorkflows.includes(n)
                    ).length;
                    const allChecked = checkedCount === groupNames.length;
                    const isIndeterminate = checkedCount > 0 && !allChecked;

                    return (
                      <div
                        key={group.prefix}
                        className="rounded-xl border border-border overflow-hidden"
                      >
                        {/* Group header */}
                        <div className="flex items-center gap-2 bg-surface-elevated px-3 py-2">
                          <GroupCheckbox
                            checked={allChecked}
                            indeterminate={isIndeterminate}
                            onChange={(): void => {
                              handleGroupToggleAll(group.workflows);
                            }}
                          />
                          <button
                            onClick={(): void => {
                              toggleGroupCollapsed(group.prefix);
                            }}
                            className="flex flex-1 items-center gap-1.5 text-left"
                          >
                            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                              {group.prefix}
                            </span>
                            <span className="text-xs text-text-tertiary">
                              ({checkedCount}/{groupNames.length})
                            </span>
                            <span className="ml-auto">
                              {isCollapsed ? (
                                <ChevronRight className="h-3.5 w-3.5 text-text-tertiary" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-text-tertiary" />
                              )}
                            </span>
                          </button>
                        </div>

                        {/* Workflow items */}
                        {!isCollapsed && (
                          <div className="flex flex-col divide-y divide-border">
                            {group.workflows.map((wf: WorkflowListEntry) => (
                              <label
                                key={wf.workflow.name}
                                className="flex cursor-pointer items-start gap-3 bg-surface px-3 py-2.5 hover:bg-surface-elevated transition-colors"
                              >
                                <input
                                  type="checkbox"
                                  checked={enabledWorkflows.includes(wf.workflow.name)}
                                  onChange={(): void => {
                                    handleWorkflowToggle(wf.workflow.name);
                                  }}
                                  className="mt-0.5 h-4 w-4 accent-primary"
                                />
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate text-sm font-medium text-text-primary">
                                      {wf.workflow.name}
                                    </span>
                                    <SourceBadge source={wf.source} />
                                  </div>
                                  {wf.workflow.description && (
                                    <span className="line-clamp-2 text-xs text-text-tertiary">
                                      {wf.workflow.description}
                                    </span>
                                  )}
                                </div>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Delete confirmation dialog ── */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{project?.name}</strong> from Archon, its workspace
              directory, and worktrees. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="px-1 text-sm text-error">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteProject}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
