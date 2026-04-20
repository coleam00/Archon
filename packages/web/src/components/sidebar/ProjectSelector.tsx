import { useState, useCallback } from 'react';
import { FolderGit2, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { CodebaseResponse } from '@/lib/api';
import { deleteCodebase } from '@/lib/api';
import { t } from '@/lib/i18n';
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

interface ProjectSelectorProps {
  projects: CodebaseResponse[];
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  isLoading: boolean;
  searchQuery?: string;
}

export function ProjectSelector({
  projects,
  selectedProjectId,
  onSelectProject,
  isLoading,
  searchQuery,
}: ProjectSelectorProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<CodebaseResponse | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = useCallback((): void => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteError(null);
    void deleteCodebase(id)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        if (id === selectedProjectId) {
          onSelectProject(null);
        }
        setDeleteTarget(null);
      })
      .catch((err: Error) => {
        setDeleteError(err.message);
      });
  }, [deleteTarget, queryClient, selectedProjectId, onSelectProject]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <span className="text-xs text-text-tertiary">{t('common.loading')}</span>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-6">
        <FolderGit2 className="h-8 w-8 text-text-tertiary" />
        <span className="text-xs text-text-tertiary">{t('sidebar.noProjects')}</span>
        <span className="text-[10px] text-text-tertiary">{t('sidebar.addRepositoryHint')}</span>
      </div>
    );
  }

  const filteredProjects = projects.filter(p => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return p.name.toLowerCase().includes(q) || (p.repository_url ?? '').toLowerCase().includes(q);
  });

  if (filteredProjects.length === 0) {
    return (
      <div className="flex items-center justify-center py-4">
        <span className="text-xs text-text-tertiary">{t('sidebar.noMatchingProjects')}</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-0.5 mt-1">
        {/* All Projects option */}
        <button
          onClick={(): void => {
            onSelectProject(null);
          }}
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors w-full',
            selectedProjectId === null
              ? 'border-l-2 border-primary bg-accent-muted text-primary'
              : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
          )}
        >
          <FolderGit2 className="h-4 w-4 shrink-0" />
          <span className="text-sm">{t('dashboard.allProjects')}</span>
        </button>
        {filteredProjects.map(project => (
          <div key={project.id} className="group relative">
            <button
              onClick={(): void => {
                onSelectProject(project.id);
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors w-full',
                selectedProjectId === project.id
                  ? 'border-l-2 border-primary bg-accent-muted text-primary'
                  : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
              )}
            >
              <FolderGit2 className="h-4 w-4 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{project.name}</span>
                {project.repository_url && (
                  <span className="truncate text-[10px] text-text-tertiary">
                    {project.repository_url}
                  </span>
                )}
              </div>
            </button>
            <button
              onClick={(e): void => {
                e.stopPropagation();
                setDeleteError(null);
                setDeleteTarget(project);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-elevated"
              title={t('sidebar.removeProject')}
            >
              <Trash2 className="h-3.5 w-3.5 text-text-tertiary hover:text-error" />
            </button>
          </div>
        ))}
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open): void => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sidebar.removeProjectTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.removeProjectPrefix')}
              <strong>{deleteTarget?.name}</strong>
              {t('sidebar.removeProjectSuffix')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-sm text-error px-1">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.remove')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
