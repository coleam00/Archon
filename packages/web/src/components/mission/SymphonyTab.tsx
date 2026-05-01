import { useState } from 'react';
import { LinearKanban } from './LinearKanban';
import { SymphonyKanban } from '@/components/symphony';
import { Button } from '@/components/ui/button';

type SymphonyView = 'linear' | 'dispatches';

/**
 * Two views in the Symphony tab:
 *  - **Linear** (default) — full-backlog kanban with bidi Linear state sync
 *    (Phase 3). Drag cards between Linear states; PATCH writes back via the
 *    Linear GraphQL mutation. Refetched every 15s for inbound sync.
 *  - **Dispatches** — the legacy `SymphonyKanban` view (Phase 2 / existing) —
 *    grouped by dispatch lifecycle / status / repository. Useful for seeing
 *    the same issues from the dispatch perspective rather than Linear's.
 */
export function SymphonyTab(): React.ReactElement {
  const [view, setView] = useState<SymphonyView>('linear');
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={view === 'linear' ? 'default' : 'outline'}
          onClick={() => {
            setView('linear');
          }}
        >
          Linear backlog
        </Button>
        <Button
          type="button"
          size="sm"
          variant={view === 'dispatches' ? 'default' : 'outline'}
          onClick={() => {
            setView('dispatches');
          }}
        >
          Dispatches
        </Button>
      </div>
      {view === 'linear' ? <LinearKanban /> : <SymphonyKanban />}
    </div>
  );
}
