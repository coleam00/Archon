import { useNavigate, useSearchParams } from 'react-router';
import { useProject } from '@/contexts/ProjectContext';
import { WorkflowList } from '@/components/workflows/WorkflowList';
import { WorkflowChain } from '@/components/workflows/WorkflowChain';
import type { WorkflowListEntry, WorkflowSource } from '@/lib/api';

export function WorkflowsPage(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedProjectId, codebases } = useProject();

  const cwd = codebases?.find(c => c.id === selectedProjectId)?.default_cwd;

  const selectedName = searchParams.get('name');
  const sourceParam = searchParams.get('source');
  const selectedSource: WorkflowSource | null =
    sourceParam === 'project' || sourceParam === 'global' || sourceParam === 'bundled'
      ? sourceParam
      : null;

  const handleSelect = (entry: WorkflowListEntry): void => {
    setSearchParams({ name: entry.workflow.name, source: entry.source });
  };

  return (
    <div className="flex flex-1 overflow-hidden bg-bridges-bg">
      <WorkflowList
        cwd={cwd}
        selectedName={selectedName}
        selectedSource={selectedSource}
        onSelect={handleSelect}
        onNew={() => {
          navigate('/workflows/builder');
        }}
      />
      {selectedName && selectedSource ? (
        <WorkflowChain
          key={`${selectedName}-${selectedSource}`}
          name={selectedName}
          source={selectedSource}
          cwd={cwd}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-center">
          <div>
            <div className="text-[15px] font-medium text-bridges-fg1">No workflow selected</div>
            <div className="mt-1 text-[13px] text-bridges-fg3">
              Pick a workflow from the list, or create a new one.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
