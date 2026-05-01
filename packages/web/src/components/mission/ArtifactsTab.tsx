import { useState, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { GalleryHorizontal, Play } from 'lucide-react';
import { listDashboardRuns, listArtifacts } from '@/lib/api';
import type { ArtifactFile, DashboardRunResponse } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ArtifactPreview } from './ArtifactPreview';
import { cn } from '@/lib/utils';
import { Mono, fmtAgo, runIdentifier } from './primitives';

type Kind = 'all' | 'video' | 'image' | 'doc' | 'data';

const KIND_TINTS: Record<Exclude<Kind, 'all'>, { bg: string; fg: string }> = {
  video: { bg: 'var(--bridges-tag-pink-bg)', fg: 'var(--bridges-tag-pink-fg)' },
  image: { bg: 'var(--bridges-tag-mint-bg)', fg: 'var(--bridges-tag-mint-fg)' },
  doc: { bg: 'var(--bridges-tag-sky-bg)', fg: 'var(--bridges-tag-sky-fg)' },
  data: { bg: 'var(--bridges-tag-butter-bg)', fg: 'var(--bridges-tag-butter-fg)' },
};

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
    staleTime: r.status === 'running' || r.status === 'pending' ? 5_000 : 60_000,
    retry: (attempt: number, err: Error): boolean => {
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
    out.sort((a, b) => b.file.createdAt.localeCompare(a.file.createdAt));
    return out;
  }, [runs, manifestQueries, filter]);

  const KINDS: Kind[] = ['all', 'video', 'image', 'doc', 'data'];

  return (
    <div className="px-6 pb-6 pt-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <h1 className="m-0 text-[18px] font-semibold tracking-tight text-bridges-fg1">Artifacts</h1>
        <span className="text-[13px] text-bridges-fg3">
          Anything a workflow wrote to its run directory.
        </span>
        <div className="flex-1" />
        <div className="inline-flex rounded-md bg-bridges-surface-muted p-0.5">
          {KINDS.map(k => (
            <button
              key={k}
              onClick={() => {
                setFilter(k);
              }}
              className={cn(
                'rounded px-3 py-1 text-[12px] font-medium capitalize transition-colors',
                filter === k
                  ? 'bg-bridges-surface text-bridges-fg1 shadow-[0_1px_2px_rgba(15,15,18,0.06)]'
                  : 'text-bridges-fg2 hover:text-bridges-fg1'
              )}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {runsLoading && <p className="text-sm text-bridges-fg2">Loading runs…</p>}
      {!runsLoading && tiles.length === 0 && (
        <p className="text-[12.5px] text-bridges-fg3">
          No artifacts yet. Workflow nodes that write to{' '}
          <Mono className="text-bridges-fg2">$ARTIFACTS_DIR</Mono> show up here.
        </p>
      )}

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
      >
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
            <p className="text-xs text-bridges-fg3">
              {openTile.run.workflow_name} · {openTile.run.codebase_name ?? '—'}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n.toString()} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Tile({ tile, onClick }: { tile: RunArtifact; onClick: () => void }): React.ReactElement {
  const k = kindOf(tile.file);
  const tint = KIND_TINTS[k];
  const sizeKb = tile.file.size ? formatBytes(tile.file.size) : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className="group overflow-hidden rounded-lg border border-bridges-border bg-bridges-surface text-left transition-shadow hover:border-bridges-border-strong hover:shadow-sm"
    >
      <div
        className={cn(
          'relative flex h-[120px] items-center justify-center overflow-hidden',
          k === 'video' && 'bg-bridges-fg1 text-white/80'
        )}
        style={
          k === 'image'
            ? { background: 'linear-gradient(135deg, #EDE9FE, #DBEAFE)' }
            : k === 'doc'
              ? { background: 'var(--bridges-surface-subtle)' }
              : k === 'data'
                ? { background: 'var(--bridges-surface-subtle)' }
                : undefined
        }
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
        ) : k === 'video' ? (
          <Play className="h-8 w-8" />
        ) : (
          <GalleryHorizontal className="h-8 w-8 text-bridges-fg3" />
        )}
      </div>
      <div className="border-t border-bridges-border-subtle px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]"
            style={{ background: tint.bg, color: tint.fg }}
          >
            {k}
          </span>
          {sizeKb && <span className="text-[11px] text-bridges-fg3">{sizeKb}</span>}
          <div className="flex-1" />
          <span className="text-[11px] text-bridges-fg3">{fmtAgo(tile.file.createdAt)}</span>
        </div>
        <Mono className="block truncate text-[12.5px] text-bridges-fg1">{tile.file.name}</Mono>
        <Mono className="mt-1 block text-[10.5px] text-bridges-fg3">{runIdentifier(tile.run)}</Mono>
      </div>
    </button>
  );
}
