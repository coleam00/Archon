import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface ArtifactViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  filename: string;
}

// Hoisted to module scope to prevent new references on every render
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

const MARKDOWN_COMPONENTS = {
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>): React.ReactElement => (
    <pre
      className="overflow-x-auto rounded-lg border border-border bg-surface p-4 font-mono text-sm"
      {...props}
    >
      {children}
    </pre>
  ),
  code: ({
    children,
    className,
    ...props
  }: React.ComponentPropsWithoutRef<'code'> & { className?: string }): React.ReactElement => {
    const isBlock = className?.startsWith('language-') || className?.startsWith('hljs');
    if (isBlock) {
      return (
        <code className={cn(className, 'font-mono')} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-background px-1.5 py-0.5 font-mono text-sm text-accent-bright"
        {...props}
      >
        {children}
      </code>
    );
  },
  blockquote: ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<'blockquote'>): React.ReactElement => (
    <blockquote className="border-l-2 border-primary pl-4 text-text-secondary" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }: React.ComponentPropsWithoutRef<'a'>): React.ReactElement => (
    <a
      className="text-primary underline decoration-primary/40 hover:decoration-primary"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
};

export function ArtifactViewerModal({
  open,
  onOpenChange,
  runId,
  filename,
}: ArtifactViewerModalProps): React.ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !filename) return;

    setLoading(true);
    setContent(null);
    setError(null);

    const encodedFilename = filename.split('/').map(encodeURIComponent).join('/');

    async function loadArtifact(): Promise<void> {
      try {
        const res = await fetch(`/api/artifacts/${encodeURIComponent(runId)}/${encodedFilename}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Failed to load artifact' }));
          throw new Error((body as { error?: string }).error ?? 'Failed to load artifact');
        }
        setContent(await res.text());
      } catch (err: unknown) {
        console.error('[ArtifactViewerModal] fetch failed', { runId, filename, err });
        setError(err instanceof Error ? err.message : 'Failed to load artifact');
      } finally {
        setLoading(false);
      }
    }

    void loadArtifact();
  }, [open, runId, filename]);

  const basename = filename.split('/').pop() ?? filename;
  const isMarkdown = basename.endsWith('.md') || basename.endsWith('.mdx');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] flex flex-col max-w-3xl">
        <DialogHeader>
          <DialogTitle>{basename}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto min-h-0">
          {loading && <p className="text-sm text-text-secondary animate-pulse">Loading…</p>}
          {error && <p className="text-sm text-error">{error}</p>}
          {content !== null &&
            (isMarkdown ? (
              <div className="chat-markdown max-w-none text-sm text-text-primary">
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="text-sm text-text-primary whitespace-pre-wrap font-mono leading-relaxed">
                {content}
              </pre>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
