import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { WorkflowList } from '@/components/workflows/WorkflowList';

export function WorkflowsPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bridges-bg">
      <div className="flex items-center justify-between border-b border-bridges-border-subtle bg-bridges-surface px-5 py-3">
        <div>
          <h1 className="text-[16px] font-semibold leading-tight text-bridges-fg1">Workflows</h1>
          <p className="text-[12px] text-bridges-fg3">
            DAG workflows. Attach an agent to any node via the Agent (agent_ref) field in the node
            inspector.
          </p>
        </div>
        <Link
          to="/workflows/builder"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-bridges-action px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-bridges-action-hover"
        >
          <Plus className="h-3.5 w-3.5" />
          New Workflow
        </Link>
      </div>
      <div className="flex-1 overflow-hidden px-4 pt-3">
        <WorkflowList />
      </div>
    </div>
  );
}
