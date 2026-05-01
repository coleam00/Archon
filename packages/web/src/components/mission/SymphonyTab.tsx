import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { LinearKanban } from './LinearKanban';
import { SymphonyKanban } from '@/components/symphony';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type SymphonyView = 'linear' | 'dispatches';

/**
 * Two views in the Symphony tab:
 *  - **Linear** (default) — full-backlog kanban with bidi Linear state sync.
 *    Drag cards between Linear states; PATCH writes back via the Linear
 *    GraphQL mutation. Refetched every 15s for inbound sync.
 *  - **Dispatches** — the legacy `SymphonyKanban` view — grouped by dispatch
 *    lifecycle / status / repository. Useful for seeing the same issues from
 *    the dispatch perspective rather than Linear's.
 */
export function SymphonyTab(): React.ReactElement {
  const [view, setView] = useState<SymphonyView>('linear');
  return (
    <div className="px-5 pb-6 pt-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <h1 className="m-0 text-[18px] font-semibold tracking-tight text-bridges-fg1">Symphony</h1>
        <span className="text-[13px] text-bridges-fg3">
          Linear backlog mirror · cached every 15s
        </span>
        <div className="flex-1" />
        <div className="inline-flex rounded-md bg-bridges-surface-muted p-0.5">
          {(['linear', 'dispatches'] as SymphonyView[]).map(v => (
            <button
              key={v}
              onClick={() => {
                setView(v);
              }}
              className={cn(
                'rounded px-3 py-1 text-[12px] font-medium transition-colors capitalize',
                view === v
                  ? 'bg-bridges-surface text-bridges-fg1 shadow-[0_1px_2px_rgba(15,15,18,0.06)]'
                  : 'text-bridges-fg2 hover:text-bridges-fg1'
              )}
            >
              {v === 'linear' ? 'Linear backlog' : 'Dispatches'}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" asChild>
          <a
            href="https://linear.app"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Linear
          </a>
        </Button>
      </div>

      {view === 'linear' ? <LinearKanban /> : <SymphonyKanban />}
    </div>
  );
}
