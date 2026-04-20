import { useParams } from 'react-router';
import { WorkflowExecution } from '@/components/workflows/WorkflowExecution';
import { t } from '@/lib/i18n';

export function WorkflowExecutionPage(): React.ReactElement {
  const { runId } = useParams<{ runId: string }>();

  if (!runId) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary">
        <p>{t('workflows.noRunId')}</p>
      </div>
    );
  }

  return <WorkflowExecution key={runId} runId={runId} />;
}
