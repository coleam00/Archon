import { useEffect, useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { ArtifactFile } from '../skills/runs';

interface ArtifactPanelProps {
  runId: string;
}

/**
 * Full-width artifact browser: sidebar of files on the left, rendered file
 * on the right. Sourced from `/api/runs/:runId/artifacts` (walks the on-disk
 * artifact dir) rather than `workflow_artifact` events — bash/script nodes
 * typically write straight to $ARTIFACTS_DIR without emitting an event.
 *
 * Markdown gets the same react-markdown + GFM + highlight stack the old UI
 * used; everything else renders as monospace plain text.
 */
export function ArtifactPanel({ runId }: ArtifactPanelProps): ReactElement {
  const {
    data: files,
    error: listError,
    loading,
  } = useEntity<ArtifactFile[]>(K.artifacts(runId), () => skill.listRunArtifacts(runId));

  const [selected, setSelected] = useState<string | null>(null);

  // Auto-select the first file once the list arrives (or when the run changes).
  useEffect(() => {
    if (files !== undefined && files.length > 0 && selected === null) {
      setSelected(files[0].path);
    }
  }, [files, selected]);

  if (loading) {
    return <div className="p-6 text-[12px] text-text-tertiary">Loading artifacts…</div>;
  }
  if (listError !== undefined) {
    return (
      <div className="p-6 font-mono text-[12px] text-error">
        Could not list artifacts: {listError.message}
      </div>
    );
  }
  if (files === undefined || files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center text-[13px] text-text-tertiary">
          <p>No artifacts written to disk for this run.</p>
          <p className="mt-2 font-mono text-[11px]">
            Workflows that emit reports or plans write them to{' '}
            <code className="rounded bg-surface-inset px-1">$ARTIFACTS_DIR</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <ArtifactSidebar files={files} selected={selected} onSelect={setSelected} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected !== null ? (
          <ArtifactViewer runId={runId} path={selected} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-text-tertiary">
            Pick a file from the left.
          </div>
        )}
      </div>
    </div>
  );
}

interface SidebarProps {
  files: ArtifactFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}

function ArtifactSidebar({ files, selected, onSelect }: SidebarProps): ReactElement {
  return (
    <nav
      aria-label="Artifacts"
      className="flex h-full w-[260px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-inset"
    >
      <header className="sticky top-0 z-10 border-b border-border bg-surface-inset px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
        Files · {files.length.toString()}
      </header>
      <ul className="flex flex-col gap-px p-2">
        {files.map(f => {
          const isSelected = selected === f.path;
          const basename = f.path.split('/').pop() ?? f.path;
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : null;
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => {
                  onSelect(f.path);
                }}
                aria-pressed={isSelected}
                className={`group flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                  isSelected ? 'bg-surface-elevated' : 'hover:bg-surface-hover'
                }`}
              >
                <span
                  className={`truncate font-mono text-[12px] ${
                    isSelected ? 'text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  {basename}
                </span>
                <span className="flex items-center justify-between gap-2 font-mono text-[10px] text-text-tertiary">
                  <span className="truncate">{dir ?? '·'}</span>
                  <span className="shrink-0 tabular-nums">{formatSize(f.size)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface ViewerProps {
  runId: string;
  path: string;
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

function ArtifactViewer({ runId, path }: ViewerProps): ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    void skill
      .fetchArtifact(runId, path)
      .then(text => {
        setContent(text);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load artifact');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [runId, path]);

  const basename = path.split('/').pop() ?? path;
  const isMarkdown = basename.endsWith('.md') || basename.endsWith('.mdx');

  return (
    <>
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-6 py-2">
        <span className="truncate font-mono text-[12px] text-text-primary">{path}</span>
        <a
          href={`/api/artifacts/${encodeURIComponent(runId)}/${path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-[10px] text-text-tertiary transition-colors hover:text-text-primary"
        >
          open raw ↗
        </a>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="font-mono text-[12px] text-text-tertiary">Loading…</p>
        ) : error !== null ? (
          <p className="font-mono text-[12px] text-error">{error}</p>
        ) : content === null ? null : isMarkdown ? (
          <div className="chat-markdown max-w-[820px] text-[13px] leading-relaxed text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="max-w-[1100px] whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-primary">
            {content}
          </pre>
        )}
      </div>
    </>
  );
}
