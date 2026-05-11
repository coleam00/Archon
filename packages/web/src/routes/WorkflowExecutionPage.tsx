import { useParams } from 'react-router';
import { WorkflowExecution } from '@/components/workflows/WorkflowExecution';

export function WorkflowExecutionPage(): React.ReactElement {
  const { runId } = useParams<{ runId: string }>();

  if (!runId) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        <p>No workflow run ID specified.</p>
      </div>
    );
  }

  return <WorkflowExecution key={runId} runId={runId} />;
}
