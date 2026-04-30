import { useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { groupCards, groupOptions, type GroupKey } from '@/lib/symphony/group';
import { useSymphonyActions, useSymphonyCards } from '@/lib/symphony/use-symphony';
import { SymphonyColumn } from './SymphonyColumn';

type Toast = { kind: 'info' | 'error'; text: string } | null;
type PendingAction = 'dispatch' | 'cancel' | null;

export function SymphonyKanban(): React.ReactElement {
  const { cards, isLoading, error } = useSymphonyCards();
  const actions = useSymphonyActions();
  const [groupBy, setGroupBy] = useState<GroupKey>('lifecycle');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [toast, setToast] = useState<Toast>(null);

  const groups = useMemo(() => groupCards(cards, groupBy), [cards, groupBy]);

  const handleDispatch = async (key: string): Promise<void> => {
    setPendingKey(key);
    setPendingAction('dispatch');
    try {
      const r = await actions.dispatchNow(key);
      setToast(
        r.ok
          ? { kind: 'info', text: `Dispatched ${key}` }
          : { kind: 'error', text: `${key}: ${r.reason ?? r.code ?? 'failed'}` }
      );
    } catch (e) {
      setToast({ kind: 'error', text: `${key}: ${(e as Error).message}` });
    } finally {
      setPendingKey(null);
      setPendingAction(null);
    }
  };

  const handleCancel = async (key: string): Promise<void> => {
    setPendingKey(key);
    setPendingAction('cancel');
    try {
      const r = await actions.cancelNow(key);
      setToast(
        r.ok
          ? { kind: 'info', text: `Cancelled ${key}` }
          : { kind: 'error', text: `${key}: ${r.reason ?? r.code ?? 'failed'}` }
      );
    } catch (e) {
      setToast({ kind: 'error', text: `${key}: ${(e as Error).message}` });
    } finally {
      setPendingKey(null);
      setPendingAction(null);
    }
  };

  const handleRefresh = async (): Promise<void> => {
    try {
      await actions.refresh();
    } catch (e) {
      setToast({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={groupBy}
          onValueChange={(v): void => {
            setGroupBy(v as GroupKey);
          }}
        >
          <TabsList>
            {groupOptions.map(opt => (
              <TabsTrigger key={opt.value} value={opt.value}>
                {opt.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{cards.length} cards</span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={actions.isRefreshing}
          >
            {actions.isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Failed to load Symphony state: {error.message}
        </div>
      )}

      {toast && (
        <div
          className={
            toast.kind === 'error'
              ? 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'
              : 'rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-primary'
          }
          role="status"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{toast.text}</span>
            <button
              type="button"
              onClick={(): void => {
                setToast(null);
              }}
              className="text-muted-foreground hover:text-text-primary"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto">
        {groups.length === 0 ? (
          <div className="flex h-40 w-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
            {isLoading ? 'Loading…' : 'No Symphony dispatches yet.'}
          </div>
        ) : (
          groups.map(g => (
            <SymphonyColumn
              key={g.key}
              group={g}
              onDispatch={(k): void => {
                void handleDispatch(k);
              }}
              onCancel={(k): void => {
                void handleCancel(k);
              }}
              pendingKey={pendingKey}
              pendingAction={pendingAction}
            />
          ))
        )}
      </div>
    </div>
  );
}
