import { Link } from 'react-router';
import { Globe, Terminal, Hash, Send, GitBranch, Trash2 } from 'lucide-react';
import type { DashboardRunResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDuration, formatStarted } from '@/lib/format';
import { platformLabel, t } from '@/lib/i18n';
import { ConfirmRunActionDialog } from './ConfirmRunActionDialog';

interface WorkflowHistoryTableProps {
  runs: DashboardRunResponse[];
  onDelete?: (runId: string) => void;
}

const STATUS_DOT_COLORS: Record<string, string> = {
  completed: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-text-tertiary',
};

const PLATFORM_ICONS: Record<string, React.ReactElement> = {
  web: <Globe className="h-3 w-3" />,
  cli: <Terminal className="h-3 w-3" />,
  slack: <Hash className="h-3 w-3" />,
  telegram: <Send className="h-3 w-3" />,
  github: <GitBranch className="h-3 w-3" />,
};

export function WorkflowHistoryTable({
  runs,
  onDelete,
}: WorkflowHistoryTableProps): React.ReactElement {
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-xs text-text-tertiary">{t('dashboard.noHistory')}</span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-elevated text-left text-text-tertiary">
            <th className="px-3 py-2 font-medium w-8">{t('dashboard.table.status')}</th>
            <th className="px-3 py-2 font-medium">{t('dashboard.table.workflow')}</th>
            <th className="px-3 py-2 font-medium">{t('dashboard.table.project')}</th>
            <th className="px-3 py-2 font-medium w-16">{t('dashboard.table.source')}</th>
            <th className="px-3 py-2 font-medium w-20">{t('dashboard.table.duration')}</th>
            <th className="px-3 py-2 font-medium w-32">{t('dashboard.table.started')}</th>
            <th className="px-3 py-2 font-medium w-20">{t('dashboard.table.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map(run => (
            <tr
              key={run.id}
              className={cn(
                'hover:bg-surface-elevated transition-colors',
                run.status === 'failed' && 'border-l-2 border-l-destructive'
              )}
            >
              <td className="px-3 py-2">
                <div
                  className={cn(
                    'h-2 w-2 rounded-full',
                    STATUS_DOT_COLORS[run.status] ?? 'bg-text-tertiary'
                  )}
                />
              </td>
              <td className="px-3 py-2">
                <Link
                  to={`/workflows/runs/${run.id}`}
                  className="text-text-primary hover:text-primary truncate block"
                >
                  {run.workflow_name}
                </Link>
                {run.user_message && (
                  <p className="text-[11px] text-text-tertiary truncate max-w-[300px]">
                    {run.user_message}
                  </p>
                )}
              </td>
              <td className="px-3 py-2 text-text-secondary truncate">
                {run.codebase_name ?? '\u2014'}
              </td>
              <td className="px-3 py-2">
                <span className="flex items-center gap-1 text-text-secondary">
                  {PLATFORM_ICONS[run.platform_type ?? ''] ?? null}
                  {run.platform_type ? platformLabel(run.platform_type) : '\u2014'}
                </span>
              </td>
              <td className="px-3 py-2 text-text-secondary">
                {formatDuration(run.started_at, run.completed_at)}
              </td>
              <td className="px-3 py-2 text-text-secondary">{formatStarted(run.started_at)}</td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/workflows/runs/${run.id}`}
                    className="text-primary hover:text-primary/80 transition-colors"
                  >
                    {t('common.viewLogs')}
                  </Link>
                  {onDelete && (
                    <ConfirmRunActionDialog
                      trigger={
                        <button
                          className="text-text-tertiary hover:text-error transition-colors"
                          title={t('dashboard.deleteRun')}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      }
                      title={t('dialog.delete.title')}
                      description={
                        <>
                          {t('dialog.delete.descriptionPrefix')}
                          <strong>{run.workflow_name}</strong>
                          {t('dialog.delete.descriptionSuffix')}
                        </>
                      }
                      confirmLabel={t('common.delete')}
                      onConfirm={(): void => {
                        onDelete(run.id);
                      }}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
