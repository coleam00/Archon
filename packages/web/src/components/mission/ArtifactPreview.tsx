import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { artifactUrl, type ArtifactFile } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface ArtifactPreviewProps {
  runId: string;
  file: ArtifactFile;
}

/**
 * Inline preview of a single artifact file. Switches on MIME type:
 * - `video/*` → HTML5 `<video controls>` with native seek (Range-aware)
 * - `image/*` → `<img>` with click-to-zoom-out toggle
 * - `text/markdown` → react-markdown
 * - `application/json` / `text/plain` / `text/html` → fetched and rendered as
 *   pre-formatted text
 * - everything else → download link
 *
 * No Kibo / Reui dependency — these are minimal shadcn-style primitives so
 * the component surface stays small. If the gallery later needs richer code
 * highlighting, swap the `<pre>` for highlight.js (already a dep) or Kibo's
 * Code Block at that point.
 */
export function ArtifactPreview({ runId, file }: ArtifactPreviewProps): React.ReactElement {
  const url = artifactUrl(runId, file.path);

  if (file.mimeType.startsWith('video/')) {
    return (
      <video controls className="max-h-[70dvh] w-full rounded-md border border-border bg-black">
        <source src={url} type={file.mimeType} />
        Your browser does not support inline video. <a href={url}>Download</a>.
      </video>
    );
  }

  if (file.mimeType.startsWith('image/')) {
    return (
      <img
        src={url}
        alt={file.name}
        className="max-h-[70dvh] w-full rounded-md border border-border object-contain"
      />
    );
  }

  if (file.mimeType.startsWith('text/markdown')) {
    return <TextFetched url={url} render="markdown" />;
  }

  if (file.mimeType.startsWith('application/json') || file.mimeType.startsWith('text/plain')) {
    return <TextFetched url={url} render="pre" />;
  }

  return (
    <div className="rounded-md border border-border bg-surface-elevated p-4 text-sm">
      <p className="text-text-primary">
        <span className="font-medium">{file.name}</span> ({formatSize(file.size)})
      </p>
      <p className="mt-1 text-xs text-text-secondary">
        Inline preview not supported for <code>{file.mimeType}</code>.
      </p>
      <div className="mt-3">
        <Button asChild type="button" variant="outline" size="sm">
          <a href={url} download={file.name}>
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}

function TextFetched({
  url,
  render,
}: {
  url: string;
  render: 'markdown' | 'pre';
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async r => {
        if (!r.ok) throw new Error(`${String(r.status)} ${r.statusText}`);
        return r.text();
      })
      .then(t => {
        if (!cancelled) setText(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return (): void => {
      cancelled = true;
    };
  }, [url]);

  if (error) return <p className="text-sm text-error">{error}</p>;
  if (text === null) return <p className="text-sm text-text-secondary">Loading…</p>;

  if (render === 'markdown') {
    return (
      <div className="prose prose-invert prose-sm max-h-[70dvh] max-w-none overflow-y-auto rounded-md border border-border bg-surface p-3">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    );
  }
  return (
    <pre className="max-h-[70dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-[11px] text-text-primary">
      {text}
    </pre>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
