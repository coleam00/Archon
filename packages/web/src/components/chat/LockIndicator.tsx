import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface LockIndicatorProps {
  locked: boolean;
  queuePosition?: number;
}

export function LockIndicator({ locked, queuePosition }: LockIndicatorProps): React.ReactElement {
  return (
    <div
      className={cn(
        'overflow-hidden transition-all duration-300',
        locked ? 'h-7 opacity-100' : 'h-0 opacity-0'
      )}
    >
      <div className="flex h-7 items-center gap-2 px-4">
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary" />
        <span className="text-xs text-text-tertiary">
          {t('chat.agentWorking')}
          {queuePosition !== undefined && queuePosition > 0 && (
            <span className="ml-1">
              {t('chat.queuePositionPrefix')} {String(queuePosition)}
              {t('chat.queuePositionSuffix')}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
