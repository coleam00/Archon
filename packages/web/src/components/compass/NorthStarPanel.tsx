import { Compass } from 'lucide-react';
import type { CompassNorthStar, CompassGhostFeatureNode } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  northStar: CompassNorthStar | null;
  selectedGhost: CompassGhostFeatureNode | null;
  repoPath?: string;
}

export function NorthStarPanel({ northStar, selectedGhost, repoPath }: Props): React.ReactElement {
  if (!northStar) {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-surface/60 px-4 py-2 text-xs">
        <Compass className="h-4 w-4 text-text-tertiary" />
        <span className="text-text-tertiary">
          No north star defined. Create{' '}
          <code className="rounded bg-zinc-800 px-1 py-0.5 text-[11px] text-text-secondary">
            {repoPath ? `${repoPath}/.archon/north-star.yaml` : '.archon/north-star.yaml'}
          </code>{' '}
          with 2-5 product objectives to enable drift scoring.
        </span>
      </div>
    );
  }

  const alignment = selectedGhost?.annotation?.north_star_alignment ?? {};

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-4 py-2">
      <div className="mr-2 flex items-center gap-1.5">
        <Compass className="h-4 w-4 text-primary" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          North star
        </span>
      </div>
      {northStar.objectives.map(o => {
        const a = alignment[o.id];
        return (
          <div
            key={o.id}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
              a === 'strengthens' && 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
              a === 'weakens' && 'border-rose-500/50 bg-rose-500/15 text-rose-300',
              a === 'neutral' && 'border-border bg-surface text-text-secondary',
              !a && 'border-border bg-surface text-text-secondary'
            )}
            title={`${o.one_liner}${
              o.examples_of_drift.length
                ? `\n\nDrift examples: ${o.examples_of_drift.join(', ')}`
                : ''
            }`}
          >
            <span className="font-medium">{o.id}</span>
            {a && (
              <span className="text-[10px] opacity-80">
                {a === 'strengthens' ? '+' : a === 'weakens' ? '−' : '='}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
