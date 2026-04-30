import { ScrollArea } from '@/components/ui/scroll-area';
import { SymphonyCard } from './SymphonyCard';
import type { GroupedCards } from '@/lib/symphony/group';

interface Props {
  group: GroupedCards;
  onDispatch: (key: string) => void;
  onCancel: (key: string) => void;
  pendingKey: string | null;
  pendingAction: 'dispatch' | 'cancel' | null;
}

export function SymphonyColumn({
  group,
  onDispatch,
  onCancel,
  pendingKey,
  pendingAction,
}: Props): React.ReactElement {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-text-primary">{group.label}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {group.cards.length}
        </span>
      </div>
      <ScrollArea className="h-[calc(100vh-12rem)]">
        <div className="flex flex-col gap-2 p-2">
          {group.cards.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">No cards</p>
          ) : (
            group.cards.map(card => (
              <SymphonyCard
                key={card.dispatch_key}
                card={card}
                onDispatch={onDispatch}
                onCancel={onCancel}
                pendingDispatch={pendingKey === card.dispatch_key && pendingAction === 'dispatch'}
                pendingCancel={pendingKey === card.dispatch_key && pendingAction === 'cancel'}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
