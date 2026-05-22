import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useKeymap, type Binding } from '../lib/keymap';
import { RunDetailHeader } from '../components/RunDetailHeader';
import { RunStream } from '../components/RunStream';
import { RunActionBar } from '../components/RunActionBar';
import { StreamToolbar, type DetailView } from '../components/StreamToolbar';
import { ApprovalContext } from '../components/ApprovalContext';
import { ApprovalPanel } from '../components/ApprovalPanel';
import { RunGraphPanel } from '../components/RunGraphPanel';
import { ArtifactPanel } from '../components/ArtifactPanel';
import { StreamContextProvider } from '../lib/stream-context';
import { useRunStreamSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import type { RunEvent } from '../primitives/event';
import type { Message } from '../primitives/message';
import type { Project } from '../primitives/project';
import type { ArtifactFile } from '../skills/runs';

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
 * Updates flow through SSE (lib/sse.ts) with a 30s safety-net refetch
 * for runs that are still running/paused.
 */
const TOGGLE_KEYS = {
  toolCalls: 'archon.console.showToolCalls',
  system: 'archon.console.showSystem',
  view: 'archon.console.detailView',
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

function readView(): DetailView {
  try {
    const stored = localStorage.getItem(TOGGLE_KEYS.view);
    return stored === 'graph' ? 'graph' : 'log';
  } catch {
    return 'log';
  }
}

function writeView(v: DetailView): void {
  try {
    localStorage.setItem(TOGGLE_KEYS.view, v);
  } catch {
    /* ignore */
  }
}

export function RunDetailPage(): ReactElement {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showToolCalls, setShowToolCalls] = useState<boolean>(() =>
    readToggle(TOGGLE_KEYS.toolCalls, true)
  );
  const [showSystem, setShowSystem] = useState<boolean>(() =>
    readToggle(TOGGLE_KEYS.system, false)
  );
  const [view, setView] = useState<DetailView>(() => readView());

  // Hoisted above any early returns so the hook order stays stable.
  const scrollToNode = useCallback((nodeId: string): void => {
    const el = document.getElementById(`node-transition-${nodeId}`);
    if (el !== null) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  // `Project | null` / `RunDetailView | null` rather than the `as unknown as T`
  // casts the original sentinel used — keeps the null path honest for
  // downstream readers (they can guard explicitly instead of meeting a
  // mis-typed value).
  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project-id',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );

  const { data: detail, error: detailError } = useEntity<RunDetailView | null>(
    runId !== undefined ? K.run(runId) : 'noop:no-run-id',
    () => (runId !== undefined ? skill.getRun(runId) : Promise.resolve(null))
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

  // Live updates: subscribe to the conversation SSE stream. Events here
  // invalidate the run and messages caches; useEntity refetches authoritative
  // state. Auto-reconnects on disconnect. The hook itself no-ops while the
  // conversation id is still unknown.
  useRunStreamSSE(conversationPlatformId, runId ?? null);

  // SSE-drop safety net: if the stream silently dies (network hiccup,
  // sleep/wake, mobile transitions) the EventSource will reconnect but we
  // may have missed terminal events in the meantime. A 30s heartbeat refetch
  // while status is non-terminal catches that without being polling proper —
  // it stops the moment the run hits a terminal state.
  const status = detail?.run.status;
  useEffect(() => {
    if (runId === undefined) return;
    if (status !== 'running' && status !== 'paused') return;
    const id = setInterval(() => {
      invalidate(K.run(runId));
      if (conversationPlatformId !== null) {
        invalidate(K.messages(conversationPlatformId));
      }
    }, 30000);
    return (): void => {
      clearInterval(id);
    };
  }, [runId, status, conversationPlatformId]);

  // Surface the artifact count on the tab even when the user hasn't visited
  // the panel yet. Cheap call — the server walks one directory. Must live
  // above any early return so the hook order stays stable across renders.
  const { data: artifactFiles } = useEntity<ArtifactFile[]>(
    runId !== undefined ? K.artifacts(runId) : 'noop:no-run-id',
    () =>
      runId !== undefined ? skill.listRunArtifacts(runId) : Promise.resolve([] as ArtifactFile[])
  );

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

  // Keymap bindings: hoisted above early returns so the hook order is stable
  // across all render paths (loading, error, ready).
  const detailStatus = detail?.run.status ?? null;
  const isPaused = detailStatus === 'paused';
  const goBack = useCallback((): void => {
    if (projectId !== undefined) navigate(`/console/p/${projectId}`);
    else navigate('/console');
  }, [navigate, projectId]);
  const setViewPersist = useCallback((next: DetailView): void => {
    setView(next);
    writeView(next);
  }, []);
  const toggleToolCalls = useCallback((): void => {
    setShowToolCalls(v => {
      const next = !v;
      writeToggle(TOGGLE_KEYS.toolCalls, next);
      return next;
    });
  }, []);
  const toggleSystem = useCallback((): void => {
    setShowSystem(v => {
      const next = !v;
      writeToggle(TOGGLE_KEYS.system, next);
      return next;
    });
  }, []);
  // Approve/Reject keymap bindings fire the matching button's click event
  // rather than lifting ApprovalPanel's internal state — keeps the panel
  // self-contained and avoids prop drilling for a paused-only shortcut.
  const clickApprove = useCallback((): void => {
    const el = document.querySelector<HTMLButtonElement>('[data-keymap-approve]');
    if (el !== null && !el.disabled) el.click();
  }, []);
  const clickReject = useCallback((): void => {
    const el = document.querySelector<HTMLButtonElement>('[data-keymap-reject]');
    if (el !== null && !el.disabled) el.click();
  }, []);
  const bindings = useMemo<readonly Binding[]>(
    () => [
      {
        keys: ['1'],
        label: 'Log tab',
        run: (): void => {
          setViewPersist('log');
        },
      },
      {
        keys: ['2'],
        label: 'Graph tab',
        run: (): void => {
          setViewPersist('graph');
        },
      },
      {
        keys: ['3'],
        label: 'Artifacts tab',
        run: (): void => {
          setViewPersist('artifacts');
        },
      },
      { keys: ['t'], label: 'Toggle tool calls', run: toggleToolCalls },
      { keys: ['s'], label: 'Toggle system', run: toggleSystem },
      {
        keys: ['a'],
        label: 'Approve',
        when: (): boolean => isPaused,
        run: clickApprove,
      },
      {
        keys: ['r'],
        label: 'Reject',
        when: (): boolean => isPaused,
        run: clickReject,
      },
      { keys: ['Escape'], label: 'Back to runs', run: goBack },
      { keys: ['h'], label: 'Back to runs', run: goBack },
    ],
    [isPaused, goBack, setViewPersist, toggleToolCalls, toggleSystem, clickApprove, clickReject]
  );
  useKeymap({ bindings });

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

  if (detail === undefined || detail === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
        Loading run…
      </div>
    );
  }

  const { run, events } = detail;
  const messageList = messages ?? [];
  const inlineToolCount = messageList.reduce((acc, m) => acc + m.toolCalls.length, 0);
  // Mirror RunStream's source-of-truth rule: when no inline tool calls exist
  // on messages, the workflow tool_called events become the canonical count.
  const workflowToolCount =
    inlineToolCount === 0
      ? events.filter(e => e.kind === 'tool_call' && e.result === null).length
      : 0;
  const toolCallCount = inlineToolCount + workflowToolCount;

  const toolbar = (
    <StreamToolbar
      view={view}
      onChangeView={next => {
        setView(next);
        writeView(next);
      }}
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
      toolCallCount={toolCallCount}
      messageCount={messageList.length}
      artifactCount={artifactFiles?.length ?? null}
    />
  );

  return (
    <StreamContextProvider value={{ runStartedAt: run.startedAt }}>
      <section className="flex h-full flex-col">
        <RunDetailHeader run={run} projectId={projectId} projectName={project?.name ?? projectId} />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {view === 'log' ? (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="w-full px-6">
                <div className="sticky top-0 z-10 -mx-6 bg-surface px-6">{toolbar}</div>

                <div className="py-4">
                  <RunStream
                    messages={messageList}
                    events={events}
                    showToolCalls={showToolCalls}
                    showSystem={showSystem}
                  />

                  {run.status === 'paused' &&
                  run.approval !== null &&
                  run.approval !== undefined ? (
                    <div className="mt-6 rounded border border-warning/30 bg-warning/[0.04] p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span
                          aria-hidden
                          className="h-2 w-2 animate-pulse rounded-full bg-warning"
                        />
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
          ) : view === 'graph' ? (
            <>
              <div className="px-6">{toolbar}</div>
              {project !== undefined && project !== null ? (
                <RunGraphPanel
                  workflowName={run.workflow}
                  projectCwd={project.path}
                  events={events}
                  onNodeSelect={(nodeId): void => {
                    setView('log');
                    writeView('log');
                    // Defer scroll until the log view has mounted.
                    requestAnimationFrame(() => {
                      scrollToNode(nodeId);
                    });
                  }}
                />
              ) : (
                <div className="p-6 text-[12px] text-text-tertiary">Loading project…</div>
              )}
            </>
          ) : (
            <>
              <div className="px-6">{toolbar}</div>
              <ArtifactPanel runId={runId} />
            </>
          )}
        </div>

        <RunActionBar run={run} />
      </section>
    </StreamContextProvider>
  );
}
