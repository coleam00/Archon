import { useState, useCallback } from 'react';
import { FolderGit2, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { CodebaseResponse } from '@/lib/api';
import { deleteCodebase } from '@/lib/api';
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
        <span className="text-xs text-[#666666]">Loading...</span>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-6">
        <FolderGit2 className="h-8 w-8 text-[#666666]" />
        <span className="text-xs text-[#666666]">No projects yet</span>
        <span className="text-[10px] text-[#666666]">Click + to add a repository</span>
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
        <span className="text-xs text-[#666666]">No matching projects</span>
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
            'flex items-center gap-2 px-3 py-2 text-left transition-colors w-full border-[3px]',
            selectedProjectId === null
              ? 'border-black bg-black text-white'
              : 'border-transparent text-[#4A4A4A] hover:border-black hover:bg-[#F0F0F0]'
          )}
        >
          <FolderGit2 className="h-4 w-4 shrink-0" />
          <span className="text-sm font-semibold">All Projects</span>
        </button>
        {filteredProjects.map(project => (
          <div key={project.id} className="group relative">
            <button
              onClick={(): void => {
                onSelectProject(project.id);
              }}
              className={cn(
                'flex items-center gap-2 px-3 py-2 text-left transition-colors w-full border-[3px]',
                selectedProjectId === project.id
                  ? 'border-black bg-black text-white'
                  : 'border-transparent text-[#4A4A4A] hover:border-black hover:bg-[#F0F0F0]'
              )}
            >
              <FolderGit2 className="h-4 w-4 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{project.name}</span>
                {project.repository_url && (
                  <span className="truncate text-[10px] text-[#666666]">
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
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 opacity-0 group-hover:opacity-100 transition-opacity border border-transparent hover:border-black"
              title="Remove project"
            >
              <Trash2 className="h-3.5 w-3.5 text-[#666666] hover:text-[#FF0000]" />
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
            <AlertDialogTitle>Remove project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteTarget?.name}</strong> from Archon, delete its
              workspace directory and worktrees. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-sm text-[#FF0000] px-1">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
