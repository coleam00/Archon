import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useKeymap, type Binding } from '../lib/keymap';
import { RunDetailHeader } from '../components/RunDetailHeader';
import { RunStream } from '../components/RunStream';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer } from '../components/ChatComposer';
import { WorkingIndicator } from '../components/WorkingIndicator';
import { RunActionBar } from '../components/RunActionBar';
import { StreamToolbar, type DetailView } from '../components/StreamToolbar';
import { ApprovalContext } from '../components/ApprovalContext';
import { ApprovalPanel } from '../components/ApprovalPanel';
import { RunGraphPanel } from '../components/RunGraphPanel';
import { ArtifactPanel } from '../components/ArtifactPanel';
import { RunStartedLine, RunFinishedLine } from '../components/RunLifecycle';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE, useRunStreamSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import { runMessageConversationId, type Run } from '../primitives/run';
import { foldNodeRuns, type RunEvent } from '../primitives/event';
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
  node: 'archon.console.runNodeFilter',
} as const;

const NEAR_BOTTOM_PX = 120;

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
    if (stored === 'chat' || stored === 'graph' || stored === 'artifacts') {
      return stored;
    }
    return 'log';
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

function readNodeFilter(): string {
  try {
    return localStorage.getItem(TOGGLE_KEYS.node) ?? 'all';
  } catch {
    return 'all';
  }
}

function writeNodeFilter(v: string): void {
  try {
    localStorage.setItem(TOGGLE_KEYS.node, v);
  } catch {
    /* ignore */
  }
}

/**
 * Resolves the parent orchestrator conversation platform ID for a workflow run
 * using a priority chain (web dispatch parent platform IDs -> metadata platform IDs -> CLI fallback).
 *
 * @param run - Workflow run object or undefined
 * @returns Resolved platform conversation ID, or null if no orchestrator conversation is linked
 */
export function resolveRunOrchestratorConversationId(
  run:
    | (Run & {
        parentPlatformId?: string | null;
        parent_platform_id?: string | null;
        conversationPlatformId?: string | null;
        conversation_platform_id?: string | null;
        workerPlatformId?: string | null;
        worker_platform_id?: string | null;
        metadata?: Record<string, unknown> | null;
      })
    | undefined
    | null
): string | null {
  if (!run) return null;
  const meta = run.metadata;
  const metaParent =
    (meta?.parent_platform_id as string | undefined) ??
    (meta?.parentPlatformId as string | undefined) ??
    (meta?.dispatch_platform_id as string | undefined) ??
    (meta?.dispatchPlatformId as string | undefined);

  return (
    run.parentPlatformId ??
    run.parent_platform_id ??
    metaParent ??
    run.conversationPlatformId ??
    run.conversation_platform_id ??
    run.workerPlatformId ??
    run.worker_platform_id ??
    null
  );
}

/**
 * Run detail page presenting multi-tab inspectability across log timeline,
 * scoped orchestrator chat, interactive DAG execution graph, and generated artifacts.
 */
export function RunDetailPage(): ReactElement {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showToolCalls, setShowToolCalls] = useState<boolean>(() =>
    readToggle(TOGGLE_KEYS.toolCalls, true)
  );
  const [showSystem, setShowSystem] = useState<boolean>(() => readToggle(TOGGLE_KEYS.system, true));
  const [view, setView] = useState<DetailView>(() => readView());
  const [selectedNodeId, setSelectedNodeId] = useState<string>(() => readNodeFilter());

  // Hoisted above any early returns so the hook order stays stable.
  const scrollToNode = useCallback((nodeId: string): boolean => {
    const scroller = scrollRef.current;
    const target = document.getElementById(`node-transition-${nodeId}`);
    if (scroller === null || target === null) return false;

    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const centeredTop =
      scroller.scrollTop +
      targetRect.top +
      targetRect.height / 2 -
      (scrollerRect.top + scroller.clientHeight / 2);
    const destination = Math.min(
      scroller.scrollHeight - scroller.clientHeight,
      Math.max(0, centeredTop)
    );
    const willMove = Math.abs(destination - scroller.scrollTop) > 1;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return willMove;
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
  // takes the *platform* conversation id, not the DB id. CLI runs expose it as
  // conversationPlatformId; chat-dispatched runs only expose the worker
  // conversation (workerPlatformId), which holds their messages (#2048). The
  // helper picks whichever is present.
  const conversationPlatformId = runMessageConversationId(detail?.run);

  const { data: messages } = useEntity<Message[]>(
    conversationPlatformId !== null
      ? K.messages(conversationPlatformId)
      : 'noop:no-conversation-id',
    () =>
      conversationPlatformId !== null
        ? skill.listMessages(conversationPlatformId)
        : Promise.resolve([])
  );

  const resolvedOrchestratorConvId = useMemo(
    () => resolveRunOrchestratorConversationId(detail?.run),
    [detail?.run]
  );
  const [activeChatConvId, setActiveChatConvId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    setActiveChatConvId(null);
    setChatBusy(false);
    setChatError(null);
  }, [runId]);

  const chatConvId = activeChatConvId ?? resolvedOrchestratorConvId;

  useConversationSSE(
    view === 'chat' ? chatConvId : null,
    useCallback(
      (locked?: boolean) => {
        if (typeof locked === 'boolean') {
          setChatBusy(locked);
        }
        if (chatConvId !== null) {
          invalidate(K.messages(chatConvId));
        }
      },
      [chatConvId]
    )
  );

  const { data: chatMessages } = useEntity<Message[]>(
    chatConvId !== null && view === 'chat' ? K.messages(chatConvId) : 'noop:no-chat-conv',
    () => (chatConvId !== null ? skill.listMessages(chatConvId) : Promise.resolve([]))
  );

  const chatMessageList = useMemo(() => {
    if (!chatMessages) return [];
    return chatMessages;
  }, [chatMessages]);

  const handleStopChat = useCallback(async () => {
    if (chatConvId === null) return;
    setChatError(null);
    try {
      await skill.stopConversationRun(chatConvId);
      setChatBusy(false);
    } catch (err) {
      console.error('Failed to stop orchestrator chat run:', err);
      setChatError(err instanceof Error ? err.message : 'Failed to stop run. Please try again.');
    }
  }, [chatConvId]);

  const onSendChat = useCallback(
    async (text: string, files?: File[]): Promise<void> => {
      if (chatBusy || projectId === undefined) return;
      setChatBusy(true);
      setChatError(null);
      try {
        let targetConvId = chatConvId;
        if (targetConvId === null) {
          const newConv = await skill.createConversation(projectId, text);
          targetConvId = newConv.conversationId;
          setActiveChatConvId(targetConvId);
          invalidate(K.conversations(projectId));
        } else {
          await skill.sendMessage(targetConvId, text, files);
        }
        invalidate(K.messages(targetConvId));
      } catch (err) {
        console.error('Failed to send orchestrator chat message:', err);
        setChatError(err instanceof Error ? err.message : 'Failed to send message');
        setChatBusy(false);
      }
    },
    [chatBusy, chatConvId, projectId]
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

  // Distinct nodes drive the node-filter dropdown — derived from the same fold
  // the stream renders, so the options match the dividers exactly.
  const nodeOptions = useMemo(
    () => foldNodeRuns(detail?.events ?? []).map(r => ({ id: r.nodeId, name: r.nodeName })),
    [detail?.events]
  );

  // Drop a persisted node selection that doesn't apply to this run (e.g. after
  // navigating to a different workflow). Guarded on the run being loaded so the
  // empty list during loading can't clobber a still-valid stored selection.
  // useLayoutEffect (not useEffect) so the reset lands before paint — navigating
  // to a cached run whose node set lacks the selection never flashes an empty
  // "Waiting for first event…" frame.
  useLayoutEffect(() => {
    if (detail === undefined || detail === null) return;
    if (selectedNodeId !== 'all' && !nodeOptions.some(o => o.id === selectedNodeId)) {
      setSelectedNodeId('all');
    }
  }, [detail, nodeOptions, selectedNodeId]);

  // Follow intent belongs to user navigation, not post-render geometry. Content
  // growth can make a pinned viewport look detached before an effect measures it.
  const lastBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const pendingNodeIdRef = useRef<string | null>(null);

  const finishNodeReveal = useCallback((nodeId: string): void => {
    if (pendingNodeIdRef.current !== nodeId) return;
    pendingNodeIdRef.current = null;
    lastBottomRef.current = false;
    setAtBottom(false);
  }, []);

  // Bind the observer to the conditional content node so it survives loading and
  // Log remounts. A Graph-selected node takes precedence over the mount's normal
  // tail position and keeps follow disabled until its reveal settles.
  const contentRef = useCallback(
    (node: HTMLDivElement | null): (() => void) | undefined => {
      if (node === null) return undefined;

      const pendingNodeId = pendingNodeIdRef.current;
      const followTail = pendingNodeId === null;
      lastBottomRef.current = followTail;
      setAtBottom(followTail);

      const observer = new ResizeObserver(() => {
        if (!lastBottomRef.current) return;
        const el = scrollRef.current;
        if (el !== null) el.scrollTop = el.scrollHeight;
      });
      observer.observe(node);

      if (pendingNodeId !== null) {
        requestAnimationFrame(() => {
          if (pendingNodeIdRef.current !== pendingNodeId) return;
          if (!scrollToNode(pendingNodeId)) finishNodeReveal(pendingNodeId);
        });
      }

      return () => {
        observer.disconnect();
      };
    },
    [finishNodeReveal, scrollToNode]
  );

  const handleScroll = useCallback((): void => {
    if (pendingNodeIdRef.current !== null) return;
    const el = scrollRef.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    lastBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
  }, []);

  const handleScrollEnd = useCallback((): void => {
    const pendingNodeId = pendingNodeIdRef.current;
    if (pendingNodeId !== null) finishNodeReveal(pendingNodeId);
  }, [finishNodeReveal]);

  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    pendingNodeIdRef.current = null;
    lastBottomRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

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
        label: 'Chat tab',
        run: (): void => {
          setViewPersist('chat');
        },
      },
      {
        keys: ['3'],
        label: 'Graph tab',
        run: (): void => {
          setViewPersist('graph');
        },
      },
      {
        keys: ['4'],
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
      messageCount={view === 'chat' ? chatMessageList.length : messageList.length}
      artifactCount={artifactFiles?.length ?? null}
      nodeOptions={nodeOptions}
      selectedNodeId={selectedNodeId}
      onSelectNode={next => {
        setSelectedNodeId(next);
        writeNodeFilter(next);
      }}
    />
  );

  return (
    <StreamContextProvider value={{ runStartedAt: run.startedAt }}>
      <section className="flex h-full flex-col">
        <RunDetailHeader run={run} projectId={projectId} projectName={project?.name ?? projectId} />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {view === 'log' ? (
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                onScrollEnd={handleScrollEnd}
                className="h-full overflow-y-auto"
              >
                <div ref={contentRef} className="w-full px-6">
                  <div className="sticky top-0 z-10 -mx-6 bg-surface px-6">{toolbar}</div>

                  <div className="py-4">
                    <RunStartedLine run={run} />

                    <div className="mt-2">
                      <RunStream
                        messages={messageList}
                        events={events}
                        showToolCalls={showToolCalls}
                        showSystem={showSystem}
                        selectedNodeId={selectedNodeId}
                      />
                    </div>

                    <RunFinishedLine run={run} />

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
              {!atBottom ? (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  aria-label="Jump to bottom"
                  className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] text-text-secondary shadow-md transition-colors hover:text-text-primary"
                >
                  <span aria-hidden>↓</span>
                  Jump to bottom
                </button>
              ) : null}
            </div>
          ) : view === 'chat' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-border bg-surface-elevated/50 px-6 py-2">
                <div className="flex items-center gap-2 font-mono text-[11px] text-text-secondary">
                  <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                  <span>Orchestrator Chat · Scoped to Run #{runId ? runId.slice(0, 8) : ''}</span>
                </div>
                {chatConvId ? (
                  <Link
                    to={`/console/p/${projectId}/chat/${chatConvId}`}
                    className="font-mono text-[11px] text-accent hover:underline"
                  >
                    Open in full Chat &rarr;
                  </Link>
                ) : null}
              </div>
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="min-h-0 flex-1 overflow-y-auto"
              >
                <div ref={contentRef} className="w-full px-6">
                  <div className="sticky top-0 z-10 -mx-6 bg-surface px-6">{toolbar}</div>
                  <div className="mx-auto max-w-[940px] py-4">
                    {chatMessageList.length === 0 && !chatBusy ? (
                      <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-sm text-text-tertiary">
                        <p>No orchestrator conversation connected yet.</p>
                        <p className="text-xs">
                          Send a message below to start an interactive orchestrator session scoped
                          to this run.
                        </p>
                      </div>
                    ) : (
                      <StreamContextProvider value={{ runStartedAt: run?.startedAt ?? null }}>
                        <ChatStream
                          messages={chatMessageList}
                          showTools={showToolCalls}
                          showSystem={showSystem}
                        />
                        {chatBusy ? (
                          <WorkingIndicator
                            activity={undefined}
                            expanded={showToolCalls}
                            onToggle={() => {
                              setShowToolCalls(v => !v);
                            }}
                          />
                        ) : null}
                      </StreamContextProvider>
                    )}
                  </div>
                </div>
              </div>
              {chatError !== null ? (
                <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-6 py-2 font-mono text-[11px] text-error">
                  {chatError}
                </div>
              ) : null}
              <ChatComposer
                onSend={onSendChat}
                disabled={chatBusy}
                isRunning={chatBusy}
                onStop={handleStopChat}
              />
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
                    pendingNodeIdRef.current = nodeId;
                    setView('log');
                    writeView('log');
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
