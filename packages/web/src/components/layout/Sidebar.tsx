import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router';
import { Plus, Loader2, ChevronDown, FolderGit2, MessageSquarePlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { SearchBar } from '@/components/sidebar/SearchBar';
import { ProjectSelector } from '@/components/sidebar/ProjectSelector';
import { ProjectDetail } from '@/components/sidebar/ProjectDetail';
import { AllConversationsView } from '@/components/sidebar/AllConversationsView';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useProject } from '@/contexts/ProjectContext';
import { addCodebase, getCodebaseInput } from '@/lib/api';
import { t } from '@/lib/i18n';

const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 260;
const STORAGE_KEY = 'archon-sidebar-width';

function getInitialWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (parsed >= SIDEBAR_MIN && parsed <= SIDEBAR_MAX) return parsed;
    }
  } catch {
    // localStorage unavailable (Safari private mode, Firefox privacy settings)
  }
  return SIDEBAR_DEFAULT;
}

export function Sidebar(): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(getInitialWidth);
  const isResizing = useRef(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);

  const navigate = useNavigate();
  const {
    selectedProjectId,
    setSelectedProjectId,
    codebases,
    isLoadingCodebases,
    isErrorCodebases,
  } = useProject();

  const selectedProject = codebases?.find(cb => cb.id === selectedProjectId) ?? null;

  // Add-project state
  const [showAddInput, setShowAddInput] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Focus input when shown
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

      let currentWidth = startWidth; // tracks the final dragged value

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const newWidth = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, startWidth + moveEvent.clientX - startX)
        );
        currentWidth = newWidth; // keep in sync with latest dragged position
        setWidth(newWidth);
      };

      const onMouseUp = (): void => {
        isResizing.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        // Persist only on mouseup to avoid 60-120Hz localStorage writes during drag
        try {
          localStorage.setItem(STORAGE_KEY, String(currentWidth)); // final dragged value
        } catch {
          // localStorage unavailable (Safari private mode, Firefox privacy settings)
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width]
  );

  const handleSelectProject = useCallback(
    (id: string | null): void => {
      setSelectedProjectId(id);
      setProjectsExpanded(false);
    },
    [setSelectedProjectId]
  );

  const handleAddSubmit = useCallback((): void => {
    const trimmed = addValue.trim();
    if (!trimmed || addLoading) return;

    setAddLoading(true);
    setAddError(null);

    void addCodebase(getCodebaseInput(trimmed))
      .then(codebase => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        handleSelectProject(codebase.id);
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
  }, [addValue, addLoading, queryClient, handleSelectProject]);

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

  const shortcuts = useMemo(
    () => ({
      '/': (): void => searchInputRef.current?.focus(),
      Escape: (): void => {
        setSearchQuery('');
        searchInputRef.current?.blur();
      },
    }),
    []
  );

  const handleNewOrchestratorChat = useCallback((): void => {
    setSelectedProjectId(null);
    navigate('/chat');
  }, [navigate, setSelectedProjectId]);

  useKeyboardShortcuts(shortcuts);

  return (
    <aside
      className="relative flex h-full flex-col border-r border-border bg-surface"
      style={{ width: `${String(width)}px` }}
    >
      {/* Logo */}
      <div className="flex flex-col gap-3 p-4">
        <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <img src="/favicon.png" alt="" className="h-8 w-8 shrink-0 object-contain" />
          <span className="text-base font-semibold text-text-primary">HarnessLab</span>
        </Link>
      </div>

      <Separator className="bg-border" />

      {/* Search - always visible */}
      <div className="px-3 py-2">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('sidebar.search')}
          inputRef={searchInputRef}
        />
      </div>

      {/* Orchestrator (unscoped) new chat */}
      <div className="px-3 pb-2">
        <button
          onClick={handleNewOrchestratorChat}
          className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
        >
          <MessageSquarePlus className="h-4 w-4 shrink-0" />
          {t('sidebar.newChat')}
        </button>
      </div>

      <Separator className="bg-border" />

      {/* Collapsible Project Selector */}
      <div className="px-2 py-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            {t('sidebar.projects')}
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
            <Plus className="h-4 w-4 text-text-tertiary hover:text-primary" />
          </button>
        </div>

        {showAddInput && (
          <div className="mt-1.5 px-1">
            <div className="flex items-center gap-1">
              <input
                ref={addInputRef}
                value={addValue}
                onChange={(e): void => {
                  setAddValue(e.target.value);
                }}
                onKeyDown={handleAddKeyDown}
                onBlur={(): void => {
                  // Close on blur only if empty and no error
                  if (!addValue.trim() && !addError) {
                    setShowAddInput(false);
                  }
                }}
                placeholder={t('sidebar.projectInputPlaceholder')}
                disabled={addLoading}
                className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
              />
              {addLoading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
            </div>
            {addError && <p className="mt-1 text-[10px] text-error line-clamp-2">{addError}</p>}
          </div>
        )}

        <Collapsible open={projectsExpanded} onOpenChange={setProjectsExpanded}>
          {selectedProjectId && !projectsExpanded ? (
            <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 mt-1 text-left text-sm text-primary hover:bg-surface-elevated transition-colors">
              <FolderGit2 className="h-4 w-4 shrink-0" />
              <span className="truncate flex-1">
                {selectedProject?.name ?? t('common.project')}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
            </CollapsibleTrigger>
          ) : (
            <CollapsibleTrigger className="hidden" />
          )}
          <CollapsibleContent>
            <div className="max-h-[35vh] overflow-y-auto">
              <ProjectSelector
                projects={codebases ?? []}
                selectedProjectId={selectedProjectId}
                onSelectProject={handleSelectProject}
                isLoading={isLoadingCodebases}
                searchQuery={searchQuery}
              />
            </div>
          </CollapsibleContent>
          {/* Show full list when no project selected (not inside collapsible content) */}
        </Collapsible>
        {!selectedProjectId && (
          <div className="max-h-[35vh] overflow-y-auto">
            <ProjectSelector
              projects={codebases ?? []}
              selectedProjectId={selectedProjectId}
              onSelectProject={handleSelectProject}
              isLoading={isLoadingCodebases}
              searchQuery={searchQuery}
            />
          </div>
        )}
        {isErrorCodebases && (
          <p className="px-2 text-[10px] text-error mt-1">{t('sidebar.loadProjectsFailed')}</p>
        )}
      </div>

      <Separator className="bg-border" />

      {/* Project-scoped or all-conversations content */}
      {selectedProjectId ? (
        <div className="min-w-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full px-2 py-2">
            <ProjectDetail
              codebaseId={selectedProjectId}
              projectName={selectedProject?.name ?? ''}
              repositoryUrl={selectedProject?.repository_url}
              searchQuery={searchQuery}
            />
          </ScrollArea>
        </div>
      ) : (
        <div className="min-w-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full px-2 py-2">
            <AllConversationsView searchQuery={searchQuery} />
          </ScrollArea>
        </div>
      )}

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-border/50 hover:bg-primary/40 transition-colors"
      />
    </aside>
  );
}
