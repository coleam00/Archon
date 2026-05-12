import { AlertCircle } from 'lucide-react';
import type { ErrorDisplay } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ErrorCardProps {
  error: ErrorDisplay;
  onRetry?: () => void;
}

export function ErrorCard({ error, onRetry }: ErrorCardProps): React.ReactElement {
  return (
    <div className="border-[3px] border-[#FF0000] bg-white p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#FF0000]" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm text-black">{error.message}</p>
            <span
              className={cn(
                'shrink-0 px-2 py-0.5 text-[10px] font-semibold border-[2px]',
                error.classification === 'transient'
                  ? 'border-[#FFA500] text-[#FFA500]'
                  : 'border-[#FF0000] text-[#FF0000]'
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
                  className="text-xs text-[#4A4A4A] hover:text-black underline"
                >
                  {action}
                </button>
              ))}
            </div>
          )}
          {error.classification === 'transient' && onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 text-xs text-[#4A4A4A] hover:text-black underline"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
