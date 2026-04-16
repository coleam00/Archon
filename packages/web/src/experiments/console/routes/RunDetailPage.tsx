import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { RunDetailHeader } from '../components/RunDetailHeader';
import { RunStream } from '../components/RunStream';
import { RunActionBar } from '../components/RunActionBar';
import { StreamToolbar } from '../components/StreamToolbar';
import { ApprovalContext } from '../components/ApprovalContext';
import { ApprovalPanel } from '../components/ApprovalPanel';
import { RunGraphPanel } from '../components/RunGraphPanel';
import { StreamContextProvider } from '../lib/stream-context';
import { useEntity, set as setCache } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import type { RunEvent } from '../primitives/event';
import type { Message } from '../primitives/message';
import type { Project } from '../primitives/project';

interface RunDetailView {
  run: Run;
  events: RunEvent[];
}

/**
 * Run detail — the "logs" page, promoted out of a hidden tab.
 *
 * Data sources:
 *   - skill.getRun(id)     → run metadata + workflow_events
 *   - skill.listMessages() → conversation messages (assistant text, user input,
 *                            persisted tool calls in metadata)
 *
 * RunStream merges both into one timeline. Paused runs render the
 * ApprovalContext + ApprovalPanel at the bottom of the stream so the user can
 * answer the gate in place.
 *
 * Polling every 3s until SSE lands in M4.
 */
const TOGGLE_KEYS = {
  toolCalls: 'archon.console.showToolCalls',
  system: 'archon.console.showSystem',
  graph: 'archon.console.showGraph',
} as const;

function readToggle(key: string, defaultOn: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultOn;
    return stored === '1';
  } catch {
    return defaultOn;
  }
}

function writeToggle(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function RunDetailPage(): ReactElement {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showToolCalls, setShowToolCalls] = useState<boolean>(() =>
    readToggle(TOGGLE_KEYS.toolCalls, true)
  );
  const [showSystem, setShowSystem] = useState<boolean>(() =>
    readToggle(TOGGLE_KEYS.system, false)
  );
  const [showGraph, setShowGraph] = useState<boolean>(() => {
    // Default: graph on at ≥1280px, off below.
    if (typeof window === 'undefined') return false;
    const stored = readToggle(TOGGLE_KEYS.graph, window.innerWidth >= 1280);
    return stored;
  });

  // Hoisted above any early returns so the hook order stays stable.
  const scrollToNode = useCallback((nodeId: string): void => {
    const el = document.getElementById(`node-transition-${nodeId}`);
    if (el !== null) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const { data: project } = useEntity<Project>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project-id',
    () =>
      projectId !== undefined
        ? skill.getProject(projectId)
        : Promise.resolve(null as unknown as Project)
  );

  const { data: detail, error: detailError } = useEntity<RunDetailView>(
    runId !== undefined ? K.run(runId) : 'noop:no-run-id',
    () =>
      runId !== undefined ? skill.getRun(runId) : Promise.resolve(null as unknown as RunDetailView)
  );

  // Messages are tied to the run's conversation — and the /messages endpoint
  // takes the *platform* conversation id, not the DB id. getRun exposes both;
  // we consume the platform id here.
  const conversationPlatformId = detail?.run.conversationPlatformId ?? null;

  const { data: messages } = useEntity<Message[]>(
    conversationPlatformId !== null
      ? K.messages(conversationPlatformId)
      : 'noop:no-conversation-id',
    () =>
      conversationPlatformId !== null
        ? skill.listMessages(conversationPlatformId)
        : Promise.resolve([])
  );

  // Polling: refetch run detail + messages every 3s while running / paused.
  useEffect(() => {
    if (runId === undefined) return;
    const alive = detail?.run.status === 'running' || detail?.run.status === 'paused';
    if (!alive) return;

    const handle = setInterval(() => {
      void skill
        .getRun(runId)
        .then(next => {
          setCache(K.run(runId), next);
        })
        .catch(() => {
          /* swallow — will surface via useEntity */
        });
      if (conversationPlatformId !== null) {
        void skill
          .listMessages(conversationPlatformId)
          .then(next => {
            setCache(K.messages(conversationPlatformId), next);
          })
          .catch(() => {
            /* swallow */
          });
      }
    }, 3000);
    return (): void => {
      clearInterval(handle);
    };
  }, [runId, conversationPlatformId, detail?.run.status]);

  // Auto-scroll to bottom on new content IF user is already near the bottom.
  const lastBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    // Near-bottom heuristic: within 120px of the end.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    lastBottomRef.current = atBottom;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !lastBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages?.length, detail?.events.length]);

  if (projectId === undefined || runId === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        Invalid run URL.
      </div>
    );
  }

  if (detailError !== undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-text-primary">Could not load run.</p>
        <p className="font-mono text-[11px] text-text-tertiary">{detailError.message}</p>
      </div>
    );
  }

  if (detail === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        Loading run…
      </div>
    );
  }

  const { run, events } = detail;
  const messageList = messages ?? [];
  const toolCallCount = messageList.reduce((acc, m) => acc + m.toolCalls.length, 0);

  return (
    <StreamContextProvider value={{ runStartedAt: run.startedAt }}>
      <section className="flex h-full flex-col">
        <RunDetailHeader run={run} projectId={projectId} projectName={project?.name ?? projectId} />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {/* Stream content centered inside its flex-1 lane with a readable
                max-width. On wide screens margins land on both sides; the
                graph (if visible) anchors to the right viewport edge. */}
            <div className="mx-auto w-full max-w-[820px] px-6">
              {/* Sticky under RunDetailHeader so toggles stay reachable
                    while the stream scrolls underneath. */}
              <div className="sticky top-0 z-10 -mx-6 bg-surface px-6">
                <StreamToolbar
                  showToolCalls={showToolCalls}
                  onToggleToolCalls={next => {
                    setShowToolCalls(next);
                    writeToggle(TOGGLE_KEYS.toolCalls, next);
                  }}
                  showSystem={showSystem}
                  onToggleSystem={next => {
                    setShowSystem(next);
                    writeToggle(TOGGLE_KEYS.system, next);
                  }}
                  showGraph={showGraph}
                  onToggleGraph={next => {
                    setShowGraph(next);
                    writeToggle(TOGGLE_KEYS.graph, next);
                  }}
                  toolCallCount={toolCallCount}
                  messageCount={messageList.length}
                />
              </div>

              <div className="py-4">
                <RunStream
                  messages={messageList}
                  events={events}
                  showToolCalls={showToolCalls}
                  showSystem={showSystem}
                />

                {run.status === 'paused' && run.approval !== null && run.approval !== undefined ? (
                  <div className="mt-6 rounded border border-warning/30 bg-warning/[0.04] p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-warning" />
                      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-warning">
                        Waiting for approval
                      </span>
                    </div>
                    <ApprovalContext run={run} />
                    <div className="mt-2">
                      <ApprovalPanel run={run} />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {showGraph && project !== undefined && project !== null ? (
            <RunGraphPanel
              workflowName={run.workflow}
              projectCwd={project.path}
              events={events}
              onNodeSelect={scrollToNode}
            />
          ) : null}
        </div>

        <RunActionBar run={run} />
      </section>
    </StreamContextProvider>
  );
}
