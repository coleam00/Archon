import { useNavigate } from 'react-router';
import { MessageSquare } from 'lucide-react';
import type { DashboardRunResponse } from '@/lib/api';
import { t } from '@/lib/i18n';
import { WorkflowRunCard } from './WorkflowRunCard';

interface WorkflowRunGroupProps {
  parentPlatformId: string | null;
  runs: DashboardRunResponse[];
  isDocker?: boolean;
  onCancel: (runId: string) => void;
  onResume?: (runId: string) => void;
  onAbandon?: (runId: string) => void;
  onDelete?: (runId: string) => void;
  onApprove?: (runId: string) => void;
  onReject?: (runId: string) => void;
}

export function WorkflowRunGroup({
  parentPlatformId,
  runs,
  isDocker,
  onCancel,
  onResume,
  onAbandon,
  onDelete,
  onApprove,
  onReject,
}: WorkflowRunGroupProps): React.ReactElement {
  const navigate = useNavigate();

  return (
    <div className="space-y-2">
      {/* Group header — only shown when there's a shared parent */}
      {parentPlatformId && (
        <div className="flex items-center gap-2 px-1">
          <div className="h-px flex-1 bg-border" />
          <button
            onClick={(): void => {
              navigate(`/chat/${encodeURIComponent(parentPlatformId)}`);
            }}
            className="flex items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 text-[11px] text-text-secondary hover:border-primary/40 hover:text-primary transition-colors shrink-0"
          >
            <MessageSquare className="h-3 w-3" />
            {String(runs.length)}
            {t('dashboard.runFromChat')}
          </button>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      {/* Cards for this group */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {runs.map(run => (
          <WorkflowRunCard
            key={run.id}
            run={run}
            isDocker={isDocker}
            onCancel={onCancel}
            onResume={onResume}
            onAbandon={onAbandon}
            onDelete={onDelete}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      </div>
    </div>
  );
}
