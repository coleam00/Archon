import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { WorkflowList } from '@/components/workflows/WorkflowList';
import { t } from '@/lib/i18n';

export function WorkflowsPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h1 className="text-lg font-semibold text-text-primary">{t('workflows.title')}</h1>
        <Link
          to="/workflows/builder"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
        >
          <Plus className="size-4" />
          {t('workflows.newWorkflow')}
        </Link>
      </div>
      <div className="flex-1 overflow-hidden px-4 pb-0 pt-2">
        <WorkflowList />
      </div>
    </div>
  );
}
