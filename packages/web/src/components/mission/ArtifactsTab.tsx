import { useState, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { listDashboardRuns, listArtifacts } from '@/lib/api';
import type { ArtifactFile, DashboardRunResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ArtifactPreview } from './ArtifactPreview';
import { cn } from '@/lib/utils';

/**
 * Tile gallery of recent artifacts across all workflow runs. Each tile shows
 * filename + run + a thumbnail of what's there (a video frame, an image, or
 * a markdown icon). Click a tile to open it in a preview dialog with full
 * scrubbing for video.
 *
 * Implementation: pulls the last 50 runs, then for each fetches its artifact
 * manifest in parallel via tanstack `useQueries`. The combined list is
 * sorted reverse-chronologically. Filterable by media kind.
 */
type Kind = 'all' | 'video' | 'image' | 'doc' | 'data';

function kindOf(file: ArtifactFile): Exclude<Kind, 'all'> {
  if (file.mimeType.startsWith('video/')) return 'video';
  if (file.mimeType.startsWith('image/')) return 'image';
  if (file.mimeType.startsWith('text/markdown') || file.mimeType.startsWith('text/html'))
    return 'doc';
  return 'data';
}

interface RunArtifact {
  run: DashboardRunResponse;
  file: ArtifactFile;
}

function buildManifestQuery(r: DashboardRunResponse): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<ArtifactFile[]>;
  staleTime: number;
  retry: (attempt: number, err: Error) => boolean;
} {
  return {
    queryKey: ['mission.artifacts.manifest', r.id],
    queryFn: () => listArtifacts(r.id),
    // Manifests for completed runs don't change. Stale-time keeps them fresh
    // for active runs and quiet for finished ones.
    staleTime: r.status === 'running' || r.status === 'pending' ? 5_000 : 60_000,
    retry: (attempt: number, err: Error): boolean => {
      // 404 = the run never wrote artifacts; don't retry.
      if (err.message.includes('404')) return false;
      return attempt < 2;
    },
  };
}

export function ArtifactsTab(): React.ReactElement {
  const [filter, setFilter] = useState<Kind>('all');
  const [openTile, setOpenTile] = useState<RunArtifact | null>(null);

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ['mission.artifacts.runs'],
    queryFn: () => listDashboardRuns({ limit: 50 }),
    refetchInterval: 30_000,
  });
  const runs = useMemo(() => runsData?.runs ?? [], [runsData]);

  // Fan out a manifest fetch per run. The list is small (50 runs) so per-run
  // queries are fine — react-query caches them and dedupes between renders.
  const manifestQueries = useQueries({
    queries: runs.map(buildManifestQuery),
  });

  const tiles: RunArtifact[] = useMemo(() => {
    const out: RunArtifact[] = [];
    runs.forEach((run, idx) => {
      const q = manifestQueries[idx];
      if (!q?.data) return;
      for (const file of q.data) {
        if (filter !== 'all' && kindOf(file) !== filter) continue;
        out.push({ run, file });
      }
    });
    // Reverse-chrono — most recent artifacts first by createdAt.
    out.sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt));
    return out;
  }, [runs, manifestQueries, filter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(['all', 'video', 'image', 'doc', 'data'] as Kind[]).map(k => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant={filter === k ? 'default' : 'outline'}
            onClick={() => {
              setFilter(k);
            }}
          >
            {k}
          </Button>
        ))}
      </div>

      {runsLoading && <p className="text-sm text-text-secondary">Loading runs…</p>}
      {!runsLoading && tiles.length === 0 && (
        <p className="text-sm text-text-secondary">
          No artifacts yet. Workflow nodes that write to <code>$ARTIFACTS_DIR</code> show up here.
        </p>
      )}

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {tiles.map(tile => (
          <Tile
            key={`${tile.run.id}-${tile.file.path}`}
            tile={tile}
            onClick={() => {
              setOpenTile(tile);
            }}
          />
        ))}
      </div>

      <Dialog
        open={openTile !== null}
        onOpenChange={open => {
          if (!open) setOpenTile(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate">{openTile?.file.name}</DialogTitle>
          </DialogHeader>
          {openTile && <ArtifactPreview runId={openTile.run.id} file={openTile.file} />}
          {openTile && (
            <p className="text-xs text-text-secondary">
              {openTile.run.workflow_name} · {openTile.run.codebase_name ?? '—'}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Tile({ tile, onClick }: { tile: RunArtifact; onClick: () => void }): React.ReactElement {
  const k = kindOf(tile.file);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col rounded-md border border-border bg-surface text-left transition-colors hover:bg-surface-elevated"
    >
      <div
        className={cn(
          'flex h-32 items-center justify-center rounded-t-md',
          k === 'video' && 'bg-black text-white/60',
          k === 'image' && 'bg-surface-elevated',
          k === 'doc' && 'bg-primary/5 text-primary',
          k === 'data' && 'bg-warning/5 text-warning'
        )}
      >
        {k === 'image' ? (
          <img
            src={`/api/artifacts/${encodeURIComponent(tile.run.id)}/${tile.file.path
              .split('/')
              .map(s => encodeURIComponent(s))
              .join('/')}`}
            alt={tile.file.name}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-xs uppercase tracking-wide">{k}</span>
        )}
      </div>
      <div className="px-2 py-1.5">
        <p className="truncate text-xs font-medium text-text-primary">{tile.file.name}</p>
        <p className="truncate text-[11px] text-text-secondary">
          {tile.run.workflow_name} · {tile.run.codebase_name ?? '—'}
        </p>
      </div>
    </button>
  );
}
