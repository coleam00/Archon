import { AlertCircle } from 'lucide-react';
import type { ErrorDisplay } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ErrorCardProps {
  error: ErrorDisplay;
  onRetry?: () => void;
}

export function ErrorCard({ error, onRetry }: ErrorCardProps): React.ReactElement {
  return (
    <div className="rounded-lg border border-border border-l-[3px] border-l-error bg-surface p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm text-text-primary">{error.message}</p>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                error.classification === 'transient'
                  ? 'bg-warning/20 text-warning'
                  : 'bg-error/20 text-error'
              )}
            >
              {error.classification === 'transient' ? 'Transient' : 'Fatal'}
            </span>
          </div>
          {error.suggestedActions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {error.suggestedActions.map((action, i) => (
                <button
                  key={i}
                  onClick={action === 'Retry' ? onRetry : undefined}
                  className="text-xs text-text-secondary hover:text-text-primary"
                >
                  {action}
                </button>
              ))}
            </div>
          )}
          {error.classification === 'transient' && onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 text-xs text-text-secondary hover:text-text-primary"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
