import { Link } from 'react-router';
import { ExternalLink, Loader2, Play, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { repositoryLabel } from '@/lib/symphony/group';
import type { Lifecycle, SymphonyCard as SymphonyCardData } from '@/lib/symphony/types';
import { cn } from '@/lib/utils';

interface Props {
  card: SymphonyCardData;
  onDispatch: (key: string) => void;
  onCancel: (key: string) => void;
  pendingDispatch?: boolean;
  pendingCancel?: boolean;
}

const LIFECYCLE_BADGE: Record<
  Lifecycle,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  running: { label: 'Running', variant: 'default' },
  retrying: { label: 'Retrying', variant: 'destructive' },
  failed: { label: 'Failed', variant: 'destructive' },
  completed: { label: 'Done', variant: 'secondary' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
};

export function SymphonyCard({
  card,
  onDispatch,
  onCancel,
  pendingDispatch,
  pendingCancel,
}: Props): React.ReactElement {
  const badge = LIFECYCLE_BADGE[card.lifecycle];
  const repo = repositoryLabel(card);
  const canDispatch =
    card.lifecycle === 'retrying' || card.lifecycle === 'failed' || card.lifecycle === 'cancelled';
  const canCancel = card.lifecycle === 'running' || card.lifecycle === 'retrying';

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-1 px-4">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">{card.identifier}</span>
          <Badge variant={badge.variant} className="text-[10px]">
            {badge.label}
          </Badge>
        </div>
        <CardTitle className="text-sm">{card.workflow_name ?? '(no workflow recorded)'}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4">
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{card.tracker}</span>
          <span className="rounded bg-muted px-1.5 py-0.5">{repo}</span>
          {card.attempt !== null && card.attempt > 1 && (
            <span className="rounded bg-muted px-1.5 py-0.5">attempt {card.attempt}</span>
          )}
        </div>
        {card.last_error && (
          <p
            className={cn(
              'line-clamp-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs',
              card.lifecycle === 'failed' || card.lifecycle === 'retrying'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
            title={card.last_error}
          >
            {card.last_error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {card.workflow_run_id ? (
            <Button asChild size="xs" variant="outline">
              <Link to={`/workflows/runs/${card.workflow_run_id}`}>
                View Run <ExternalLink />
              </Link>
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">no run recorded</span>
          )}
          {canDispatch && (
            <Button
              size="xs"
              variant="default"
              onClick={(): void => {
                onDispatch(card.dispatch_key);
              }}
              disabled={pendingDispatch}
            >
              {pendingDispatch ? <Loader2 className="animate-spin" /> : <Play />}
              Dispatch
            </Button>
          )}
          {canCancel && (
            <Button
              size="xs"
              variant="ghost"
              onClick={(): void => {
                onCancel(card.dispatch_key);
              }}
              disabled={pendingCancel}
            >
              {pendingCancel ? <Loader2 className="animate-spin" /> : <X />}
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
