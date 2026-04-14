import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Plus,
  Loader2,
  ChevronDown,
  FolderGit2,
  Trash2,
  Settings,
  MessageSquarePlus,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ProjectDetail } from '@/components/sidebar/ProjectDetail';
import { useProject } from '@/contexts/ProjectContext';
import { addCodebase, deleteCodebase } from '@/lib/api';
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

interface ProjectsSidebarProps {
  searchQuery: string;
  onNavigate?: () => void;
}

export function ProjectsSidebar({
  searchQuery,
  onNavigate,
}: ProjectsSidebarProps): React.ReactElement {
  const navigate = useNavigate();
  const {
    selectedProjectId,
    setSelectedProjectId,
    codebases,
    isLoadingCodebases,
    isErrorCodebases,
  } = useProject();
  const queryClient = useQueryClient();

  const [showAddInput, setShowAddInput] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const [settingsOpenId, setSettingsOpenId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const handleDeleteConfirm = useCallback((): void => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteError(null);
    void deleteCodebase(id)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        if (id === selectedProjectId) {
          setSelectedProjectId(null);
        }
        setDeleteTargetId(null);
      })
      .catch((err: Error) => {
        setDeleteError(err.message);
      });
  }, [deleteTargetId, queryClient, selectedProjectId, setSelectedProjectId]);

  const handleUnscopedChat = useCallback((): void => {
    setSelectedProjectId(null);
    navigate('/chat');
    onNavigate?.();
  }, [setSelectedProjectId, navigate, onNavigate]);

  const filteredCodebases = codebases?.filter(cb => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return cb.name.toLowerCase().includes(q) || (cb.repository_url ?? '').toLowerCase().includes(q);
  });

  const deleteTarget = codebases?.find(cb => cb.id === deleteTargetId);

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Projects
        </span>
        <button
          onClick={(): void => {
            setShowAddInput(prev => !prev);
            setAddError(null);
            setAddValue('');
          }}
          className="p-1 rounded hover:bg-surface-elevated transition-colors"
          title="Add project"
          aria-label="Add project"
        >
          <Plus className="h-4 w-4 text-text-tertiary hover:text-primary" />
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
              placeholder="GitHub URL or local path"
              disabled={addLoading}
              className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
            />
            {addLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
          </div>
          {addError && <p className="mt-1 text-[10px] text-error line-clamp-2">{addError}</p>}
        </div>
      )}

      <div className="px-3 pb-2 shrink-0">
        <button
          onClick={handleUnscopedChat}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
        >
          <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
          New unscoped chat
        </button>
      </div>

      <Separator className="bg-border shrink-0" />

      <ScrollArea className="flex-1 min-h-0 px-2 py-2">
        {isLoadingCodebases ? (
          <div className="flex items-center justify-center py-4">
            <span className="text-xs text-text-tertiary">Loading projects...</span>
          </div>
        ) : isErrorCodebases ? (
          <p className="px-2 text-[10px] text-error mt-1">Failed to load projects — retrying</p>
        ) : !filteredCodebases || filteredCodebases.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-6">
            <FolderGit2 className="h-8 w-8 text-text-tertiary" />
            <span className="text-xs text-text-tertiary text-center">
              {codebases && codebases.length > 0 ? 'No matching projects' : 'No projects yet'}
            </span>
            {(!codebases || codebases.length === 0) && (
              <span className="text-[10px] text-text-tertiary">Click + to add a repository</span>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filteredCodebases.map(project => (
              <div key={project.id} className="group/project">
                <Collapsible
                  open={selectedProjectId === project.id}
                  onOpenChange={(open): void => {
                    setSelectedProjectId(open ? project.id : null);
                    if (!open && settingsOpenId === project.id) {
                      setSettingsOpenId(null);
                    }
                  }}
                >
                  <div className="relative flex items-center">
                    <CollapsibleTrigger
                      className={cn(
                        'flex flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors pr-8',
                        selectedProjectId === project.id
                          ? 'bg-accent-muted text-primary'
                          : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
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
        )}
      </ScrollArea>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open): void => {
          if (!open) {
            setDeleteTargetId(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteTarget?.name}</strong> from Archon, delete its
              workspace directory and worktrees. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-sm text-error px-1">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
