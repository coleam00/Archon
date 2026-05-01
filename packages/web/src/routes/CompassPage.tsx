import { Compass } from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { CompassCanvas } from '@/components/compass/CompassCanvas';

export function CompassPage(): React.ReactElement {
  const { selectedProjectId, codebases, setSelectedProjectId, isLoadingCodebases } = useProject();

  if (isLoadingCodebases) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
        Loading codebases…
      </div>
    );
  }

  if (!codebases || codebases.length === 0) {
    return (
      <EmptyState
        title="No codebases registered"
        body="Register a codebase from /chat or /workflows before opening Compass."
      />
    );
  }

  const selected = selectedProjectId
    ? (codebases.find(c => c.id === selectedProjectId) ?? null)
    : null;

  if (!selected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <Compass className="h-10 w-10 text-text-tertiary" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Compass</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Pick a codebase to see its feature graph and propose what to build next.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {codebases.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={(): void => {
                setSelectedProjectId(c.id);
              }}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm hover:border-primary hover:text-primary"
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <CompassCanvas codebaseId={selected.id} repoPath={selected.default_cwd} />
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Compass className="h-8 w-8 text-text-tertiary" />
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="text-sm text-text-secondary">{body}</p>
    </div>
  );
}
