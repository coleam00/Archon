import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { listWorkflows, type WorkflowDefinition } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';
import { WorkflowCard } from '@/components/workflows/WorkflowCard';
import { RunWorkflowDialog } from '@/components/workflows/RunWorkflowDialog';
import { getWorkflowCategory, CATEGORIES, type WorkflowCategory } from '@/lib/workflow-metadata';

export function WorkflowList(): React.ReactElement {
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [workflowToRun, setWorkflowToRun] = useState<WorkflowDefinition | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<WorkflowCategory>('All');
  const { codebases, selectedProjectId } = useProject();
  const [localProjectId, setLocalProjectId] = useState<string | null>(selectedProjectId);

  useEffect(() => {
    setLocalProjectId(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    setSelectedWorkflow(null);
  }, [searchQuery, activeCategory]);

  const selectedCwd = localProjectId
    ? codebases?.find(cb => cb.id === localProjectId)?.default_cwd
    : undefined;

  const {
    data: workflows,
    isLoading: loadingWorkflows,
    isError: workflowsError,
  } = useQuery({
    queryKey: ['workflows', selectedCwd ?? null],
    queryFn: () => listWorkflows(selectedCwd),
  });

  const filteredWorkflows = useMemo(() => {
    if (!workflows) return [];
    return workflows
      .map(entry => entry.workflow)
      .filter(wf => {
        if (searchQuery) {
          const query = searchQuery.toLowerCase();
          const matchesName = wf.name.toLowerCase().includes(query);
          const matchesDesc = wf.description?.toLowerCase().includes(query) ?? false;
          if (!matchesName && !matchesDesc) return false;
        }

        if (activeCategory !== 'All') {
          const category = getWorkflowCategory(wf.name, wf.description ?? '');
          if (category !== activeCategory) return false;
        }

        return true;
      });
  }, [workflows, searchQuery, activeCategory]);

  if (loadingWorkflows) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-text-secondary">
        Loading workflows...
      </div>
    );
  }

  if (workflowsError) {
    return (
      <div className="text-sm text-error">Failed to load workflows. Check server connectivity.</div>
    );
  }

  const hasWorkflows = workflows != null && workflows.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-auto p-0">
        {hasWorkflows && (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e): void => {
                  setSearchQuery(e.target.value);
                }}
                placeholder="Search workflows..."
                className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {CATEGORIES.map(category => (
                <button
                  key={category}
                  onClick={(): void => {
                    setActiveCategory(category);
                  }}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    activeCategory === category
                      ? 'bg-primary text-white'
                      : 'bg-surface-elevated text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>
        )}

        {!hasWorkflows ? (
          <div className="text-sm text-text-secondary">
            No workflows found. Add workflow definitions to{' '}
            <code className="rounded bg-surface-inset px-1 py-0.5 text-xs">.archon/workflows/</code>
          </div>
        ) : filteredWorkflows.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            No workflows match your search.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredWorkflows.map(workflow => (
              <WorkflowCard
                key={workflow.name}
                workflow={workflow}
                isSelected={selectedWorkflow === workflow.name}
                onToggle={(name): void => {
                  setSelectedWorkflow(selectedWorkflow === name ? null : name);
                }}
                onRun={(name): void => {
                  setSelectedWorkflow(name);
                  setWorkflowToRun(workflow);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <RunWorkflowDialog
        workflow={workflowToRun}
        codebases={codebases}
        selectedProjectId={localProjectId}
        onOpenChange={(open): void => {
          if (!open) setWorkflowToRun(null);
        }}
      />
    </div>
  );
}
