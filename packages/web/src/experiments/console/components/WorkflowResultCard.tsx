/* eslint-disable no-restricted-imports */
import { useState, useMemo, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkflowStore } from '@/stores/workflow-store';
import { getWorkflowRun } from '@/lib/api';
import { StatusIcon } from '@/components/workflows/StatusIcon';
import { ArtifactSummary } from '@/components/workflows/ArtifactSummary';
import { ArtifactViewerModal } from '@/components/workflows/ArtifactViewerModal';
import { formatDurationMs, ensureUtc } from '@/lib/format';
import type { WorkflowArtifact, ArtifactType } from '@/lib/types';

// Matches artifact paths (forward- and back-slash safe); groups: [1] runId, [2] filename
const ARTIFACT_PATH_RE = /artifacts[/\\]runs[/\\]([a-fA-F0-9-]+)[/\\](.+)/;

/**
 * Extracts the run ID and artifact relative filename from a text snippet or path.
 * Defends against path traversal sequences.
 *
 * @param text - Path or message snippet containing artifact location
 * @returns Object with runId and cleaned filename, or null if no valid artifact path found
 */
export function extractArtifactInfo(text: string): { runId: string; filename: string } | null {
  const match = ARTIFACT_PATH_RE.exec(text);
  if (!match) return null;
  const filename = match[2].replace(/\\/g, '/');
  if (filename.split('/').some(s => s === '..')) return null;
  return { runId: match[1], filename };
}

/**
 * Generates custom markdown renderers with interactive linkification for workflow artifacts.
 *
 * @param onArtifactClick - Callback fired when a markdown artifact link is clicked
 * @returns React Markdown components map
 */
export function makeResultMarkdownComponents(
  onArtifactClick: (runId: string, filename: string) => void
): Components {
  return {
    a: ({ children, ...props }: React.ComponentPropsWithoutRef<'a'>): ReactElement => (
      <a
        className="text-primary underline decoration-primary/40 hover:decoration-primary"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    ),
    code: ({
      children,
      className,
      ...props
    }: React.ComponentPropsWithoutRef<'code'> & { className?: string }): ReactElement => {
      const isBlock = className?.startsWith('language-') || className?.startsWith('hljs');
      if (isBlock) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      if (typeof children === 'string') {
        const artifact = extractArtifactInfo(children);
        if (artifact) {
          const { runId, filename } = artifact;
          const displayName = filename.split('/').pop() ?? filename;
          const encodedFilename = filename.split('/').map(encodeURIComponent).join('/');
          const artifactHref = `/api/artifacts/${encodeURIComponent(runId)}/${encodedFilename}`;
          return (
            <a
              href={artifactHref}
              onClick={
                filename.endsWith('.md')
                  ? (e: React.MouseEvent): void => {
                      e.preventDefault();
                      onArtifactClick(runId, filename);
                    }
                  : undefined
              }
              target={filename.endsWith('.md') ? undefined : '_blank'}
              rel={filename.endsWith('.md') ? undefined : 'noopener noreferrer'}
              className="!text-accent-bright hover:!text-primary font-mono font-medium underline decoration-accent-bright/40 hover:decoration-accent-bright"
            >
              {displayName}
            </a>
          );
        }
      }
      return (
        <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono text-[0.9em]" {...props}>
          {children}
        </code>
      );
    },
  };
}

/**
 * Properties for the WorkflowResultCard component.
 */
export interface WorkflowResultCardProps {
  /** Workflow run ID. */
  runId: string;
  /** Name of the workflow definition that completed. */
  workflowName: string;
  /** Markdown content summarizing the run outcome. */
  content: string;
}

/**
 * Result card rendered in the chat stream when a workflow execution concludes.
 * Surfaces execution status, duration, completed node count, and interactive artifact summaries.
 */
export function WorkflowResultCard({
  workflowName,
  runId,
  content,
}: WorkflowResultCardProps): ReactElement {
  const navigate = useNavigate();
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  const [expanded, setExpanded] = useState(false);
  const [artifactViewer, setArtifactViewer] = useState<{
    runId: string;
    filename: string;
  } | null>(null);

  // setArtifactViewer is a stable React state setter — empty dep array is intentional
  const mdComponents = useMemo(
    () =>
      makeResultMarkdownComponents((aRunId, filename) => {
        setArtifactViewer({ runId: aRunId, filename });
      }),
    []
  );

  // Zustand live state (populated if user had the page open during execution)
  const liveState = useWorkflowStore(state => state.workflows.get(runId));

  // One-time API fetch: staleTime: Infinity because a terminal run record is immutable —
  // status, timestamps, and events do not change once completed/failed/cancelled.
  const { data: runData, isError } = useQuery({
    queryKey: ['workflowRun', runId],
    queryFn: () => getWorkflowRun(runId),
    staleTime: Infinity,
  });

  const projectId =
    routeProjectId ??
    runData?.run?.codebase_id ??
    (liveState as { projectId?: string } | undefined)?.projectId;

  // Merge: prefer live state when available
  const status = liveState?.status ?? runData?.run?.status ?? 'completed';
  const dagNodes = liveState?.dagNodes ?? [];
  const storeArtifacts = liveState?.artifacts ?? [];
  const startedAt =
    liveState?.startedAt ??
    (runData?.run?.started_at ? new Date(ensureUtc(runData.run.started_at)).getTime() : null);
  const completedAt =
    liveState?.completedAt ??
    (runData?.run?.completed_at ? new Date(ensureUtc(runData.run.completed_at)).getTime() : null);
  const duration = startedAt != null && completedAt != null ? completedAt - startedAt : null;

  // Node counts: prefer live dagNodes (exact), fall back to events (approximation —
  // totalCount is nodes that reached a terminal state, not the workflow's full node count).
  let completedCount: number;
  let totalCount: number;
  if (dagNodes.length > 0) {
    completedCount = dagNodes.filter(n => n.status === 'completed').length;
    // Only count terminal nodes (same semantics as events fallback path)
    totalCount = dagNodes.filter(
      n => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped'
    ).length;
  } else {
    const events = runData?.events ?? [];
    const terminalEvents = events.filter(
      e =>
        e.event_type === 'node_completed' ||
        e.event_type === 'node_failed' ||
        e.event_type === 'node_skipped'
    );
    completedCount = events.filter(e => e.event_type === 'node_completed').length;
    totalCount = terminalEvents.length;
  }

  // Artifacts: prefer live store, fall back to events
  const eventArtifacts: WorkflowArtifact[] = (runData?.events ?? [])
    .filter(e => e.event_type === 'workflow_artifact')
    .map(e => {
      const d = e.data;
      return {
        type: (typeof d.artifactType === 'string'
          ? d.artifactType
          : 'file_created') as ArtifactType,
        label: typeof d.label === 'string' ? d.label : '',
        url: typeof d.url === 'string' ? d.url : undefined,
        path: typeof d.path === 'string' ? d.path : undefined,
      };
    });
  const artifacts = storeArtifacts.length > 0 ? storeArtifacts : eventArtifacts;

  // If API fetch failed and no live state, show degraded card with just content + link
  const fetchFailed = isError && !liveState;

  // Status-aware header title
  let headerTitle: string;
  if (status === 'failed') {
    headerTitle = 'Workflow failed';
  } else if (status === 'cancelled') {
    headerTitle = 'Workflow cancelled';
  } else {
    headerTitle = 'Workflow complete';
  }

  // Expand/collapse for text content
  const lines = content.split('\n');
  const isTruncatable = content.length > 500 || lines.length > 8;
  const previewText = lines.slice(0, 8).join('\n').slice(0, 500);
  const preview = isTruncatable
    ? previewText + (previewText.length < content.length ? '...' : '')
    : content;
  const displayContent = expanded || !isTruncatable ? content : preview;

  const handleViewFullLogs = (): void => {
    if (projectId) {
      void navigate(`/console/p/${projectId}/r/${runId}`);
    } else {
      void navigate(`/console/r/${runId}`);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border bg-surface overflow-hidden max-w-3xl">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-elevated">
          <span className="shrink-0">
            <StatusIcon status={fetchFailed ? 'completed' : status} />
          </span>
          <span className="text-xs font-medium text-text-primary truncate flex-1">
            {headerTitle}: {workflowName}
          </span>
          {!fetchFailed && totalCount > 0 && (
            <span className="shrink-0 text-[10px] text-text-secondary">
              {completedCount}/{totalCount} nodes
            </span>
          )}
          {!fetchFailed && duration != null && (
            <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-text-secondary shrink-0">
              {formatDurationMs(duration)}
            </span>
          )}
          <button
            onClick={handleViewFullLogs}
            className="text-[10px] text-primary hover:text-accent-bright transition-colors shrink-0"
          >
            View full logs &rarr;
          </button>
        </div>
        <div className="px-3 py-2">
          {!fetchFailed && artifacts.length > 0 && (
            <div className="mb-2">
              <ArtifactSummary artifacts={artifacts} runId={runId} />
            </div>
          )}
          <div className="chat-markdown text-xs text-text-secondary">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {displayContent}
            </ReactMarkdown>
          </div>
          {isTruncatable && (
            <button
              onClick={(): void => {
                setExpanded(!expanded);
              }}
              className="mt-1 text-[10px] text-primary hover:text-accent-bright transition-colors"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </div>
      {artifactViewer && (
        <ArtifactViewerModal
          open={true}
          onOpenChange={(): void => {
            setArtifactViewer(null);
          }}
          runId={artifactViewer.runId}
          filename={artifactViewer.filename}
        />
      )}
    </>
  );
}
