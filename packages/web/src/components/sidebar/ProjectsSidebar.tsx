import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Loader2, FolderGit2, MessageSquare, ChevronRight } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProject } from '@/contexts/ProjectContext';
import { addCodebase, listConversations } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ProjectsSidebarProps {
  searchQuery: string;
  onNavigate?: () => void;
}

const MAX_VISIBLE = 4;

export function ProjectsSidebar({
  searchQuery,
  onNavigate,
}: ProjectsSidebarProps): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { setSelectedProjectId, codebases, isLoadingCodebases, isErrorCodebases } = useProject();
  const queryClient = useQueryClient();

  const [showAddInput, setShowAddInput] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showAddInput) {
      addInputRef.current?.focus();
    }
  }, [showAddInput]);

  const handleAddSubmit = useCallback((): void => {
    const trimmed = addValue.trim();
    if (!trimmed || addLoading) return;
    setAddLoading(true);
    setAddError(null);
    const isLocalPath =
      trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Za-z]:[/\\]/.test(trimmed);
    const input = isLocalPath ? { path: trimmed } : { url: trimmed };
    void addCodebase(input)
      .then(async codebase => {
        await queryClient.invalidateQueries({ queryKey: ['codebases'] });
        setSelectedProjectId(codebase.id);
        navigate(`/projects/${codebase.id}`);
        onNavigate?.();
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
  }, [addValue, addLoading, queryClient, setSelectedProjectId, navigate, onNavigate]);

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

  // Recent conversations (all projects, no filter)
  const { data: recentConversations } = useQuery({
    queryKey: ['conversations', { recent: true }],
    queryFn: () => listConversations(),
    refetchInterval: 15_000,
  });

  const sortedRecent = [...(recentConversations ?? [])]
    .sort((a, b) => {
      const aTime = a.last_activity_at ?? a.created_at;
      const bTime = b.last_activity_at ?? b.created_at;
      return bTime.localeCompare(aTime);
    })
    .slice(0, 5);

  // Projects sorted desc by created_at, filtered by search
  const filteredCodebases = [...(codebases ?? [])]
    .filter(cb => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        cb.name.toLowerCase().includes(q) || (cb.repository_url ?? '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const visibleCodebases = expanded ? filteredCodebases : filteredCodebases.slice(0, MAX_VISIBLE);
  const hasMore = filteredCodebases.length > MAX_VISIBLE;

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      {/* New project button */}
      <div className="px-3 py-2 shrink-0">
        <button
          onClick={(): void => {
            setShowAddInput(prev => !prev);
            setAddError(null);
            setAddValue('');
          }}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-text-primary bg-surface-elevated hover:bg-accent transition-colors"
        >
          <Plus className="h-4 w-4 shrink-0 text-text-secondary" />
          New project
        </button>
      </div>

      {showAddInput && (
        <div className="px-3 pb-2 shrink-0">
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
              placeholder="GitHub URL ou chemin local"
              disabled={addLoading}
              className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
            />
            {addLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
          </div>
          {addError && <p className="mt-1 text-[10px] text-error line-clamp-2">{addError}</p>}
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0 px-2 py-1">
        {/* Projects section */}
        <div className="mb-2">
          <span className="block px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Projets
          </span>
          <div className="flex flex-col gap-0.5">
            {isLoadingCodebases ? (
              <div className="flex items-center justify-center py-4">
                <span className="text-xs text-text-tertiary">Chargement...</span>
              </div>
            ) : isErrorCodebases ? (
              <p className="px-2 text-[10px] text-error">Échec du chargement</p>
            ) : visibleCodebases.length === 0 ? (
              <span className="block px-2 py-2 text-xs text-text-tertiary">
                {codebases && codebases.length > 0
                  ? 'Aucun projet correspondant'
                  : 'Aucun projet — cliquez + pour ajouter'}
              </span>
            ) : (
              visibleCodebases.map(project => {
                const isActive = location.pathname === `/projects/${project.id}`;
                return (
                  <button
                    key={project.id}
                    onClick={(): void => {
                      setSelectedProjectId(project.id);
                      navigate(`/projects/${project.id}`);
                      onNavigate?.();
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-accent-muted text-primary'
                        : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                    )}
                  >
                    <FolderGit2
                      className={cn(
                        'h-4 w-4 shrink-0',
                        isActive ? 'text-primary' : 'text-text-tertiary'
                      )}
                    />
                    <span className="flex-1 truncate font-medium">{project.name}</span>
                    <ChevronRight
                      className={cn(
                        'ml-auto h-3.5 w-3.5 shrink-0 transition-opacity',
                        isActive ? 'opacity-60' : 'opacity-0'
                      )}
                    />
                  </button>
                );
              })
            )}

            {hasMore && !isLoadingCodebases && !isErrorCodebases && (
              <button
                onClick={(): void => {
                  setExpanded(prev => !prev);
                }}
                className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-tertiary hover:text-primary transition-colors"
              >
                {expanded
                  ? 'Voir moins'
                  : `Voir plus (${String(filteredCodebases.length - MAX_VISIBLE)})`}
              </button>
            )}
          </div>
        </div>

        {/* Recents section */}
        <div className="mt-1">
          <span className="block px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Récents
          </span>
          <div className="flex flex-col gap-0.5">
            {sortedRecent.length === 0 ? (
              <span className="block px-2 py-2 text-xs text-text-tertiary">
                Aucune conversation
              </span>
            ) : (
              sortedRecent.map(conv => {
                const convId = conv.platform_conversation_id;
                const isActive = location.pathname === `/chat/${encodeURIComponent(convId)}`;
                const title = conv.title ?? 'Conversation sans titre';
                return (
                  <button
                    key={conv.id}
                    onClick={(): void => {
                      navigate(`/chat/${encodeURIComponent(convId)}`);
                      onNavigate?.();
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-accent-muted text-primary'
                        : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                    )}
                  >
                    <MessageSquare
                      className={cn(
                        'h-4 w-4 shrink-0',
                        isActive ? 'text-primary' : 'text-text-tertiary'
                      )}
                    >
                      <FolderGit2 className="h-4 w-4 shrink-0" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{project.name}</span>
                        {project.repository_url && (
                          <span className="truncate text-[10px] text-text-tertiary">
                            {project.repository_url}
                          </span>
                        )}
                      </div>
                      <ChevronDown
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                          selectedProjectId === project.id && 'rotate-180'
                        )}
                      />
                    </CollapsibleTrigger>
                    <button
                      onClick={(e): void => {
                        e.stopPropagation();
                        setDeleteError(null);
                        setDeleteTargetId(project.id);
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-100 md:opacity-0 md:group-hover/project:opacity-100 transition-opacity hover:bg-surface-elevated"
                      title="Remove project"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-text-tertiary hover:text-error" />
                    </button>
                  </div>

                  <CollapsibleContent>
                    <div className="ml-3 border-l border-border pl-2 mt-1 mb-1">
                      <ProjectDetail
                        codebaseId={project.id}
                        projectName={project.name}
                        repositoryUrl={project.repository_url}
                        searchQuery={searchQuery}
                      />

                      <Collapsible
                        open={settingsOpenId === project.id}
                        onOpenChange={(open): void => {
                          setSettingsOpenId(open ? project.id : null);
                        }}
                      >
                        <CollapsibleTrigger className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors">
                          <Settings className="h-3.5 w-3.5 shrink-0" />
                          <span>Project settings</span>
                          <ChevronDown
                            className={cn(
                              'ml-auto h-3 w-3 shrink-0 transition-transform duration-200',
                              settingsOpenId === project.id && 'rotate-180'
                            )}
                          />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="px-2 py-2 flex flex-col gap-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] text-text-secondary">
                                Allow env keys
                              </span>
                              <span
                                className={cn(
                                  'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                                  project.allow_env_keys
                                    ? 'bg-success/10 text-success'
                                    : 'bg-surface-elevated text-text-tertiary'
                                )}
                              >
                                {project.allow_env_keys ? 'enabled' : 'disabled'}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[11px] text-text-secondary">
                                Working directory
                              </span>
                              <span className="font-mono text-[10px] text-text-tertiary truncate">
                                {project.default_cwd}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[11px] text-text-secondary">Description</span>
                              <span className="text-[10px] text-text-tertiary italic">
                                Not available via API
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[11px] text-text-secondary">
                                Allowed workflows
                              </span>
                              <span className="text-[10px] text-text-tertiary italic">
                                Coming soon
                              </span>
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
