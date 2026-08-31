import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer } from '../components/ChatComposer';
import { ChatHistoryPanel } from '../components/ChatHistoryPanel';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { WorkingIndicator } from '../components/WorkingIndicator';
import { WorkflowDock } from '../components/WorkflowDock';
import { EmptyState } from '../components/EmptyState';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { ensureUtc } from '../lib/format';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import type { Message } from '../primitives/message';
import type { ConversationSummary } from '../primitives/conversation';
import type { Run } from '../primitives/run';
import type { RunCounts } from '../skills/runs';

// While a turn is active, refetch messages on this cadence so streamed replies
// still surface if a per-conversation SSE event is dropped (cross-origin
// EventSource in dev can miss bursts). Mirrors RunDetailPage's safety-net poll.
const ACTIVE_POLL_MS = 3000;
// Consider the turn done once the trailing message is an assistant reply that
// has stayed stable this long. Independent of any SSE lock event.
const SETTLE_MS = 6000;
// Hard cap so a turn that never produces a reply (server error, etc.) can't
// disable the composer forever.
const MAX_WAIT_MS = 300_000;
// Distance from the bottom (px) within which we treat the scroll as "at bottom"
// — drives both auto-scroll stickiness and the jump-to-bottom button's visibility.
const NEAR_BOTTOM_PX = 120;

/**
 * Resolves the next active conversation ID when a conversation is deleted.
 *
 * @param deletedId - ID of the conversation being deleted
 * @param activeId - Currently active conversation ID
 * @param conversations - List of remaining conversation summaries
 * @returns Next conversation ID to select, or null if list is empty
 */
export function resolveNextActiveConversation(
  deletedId: string,
  activeId: string | null,
  conversations: { id: string }[]
): string | null {
  if (activeId !== deletedId) return activeId;
  const remaining = conversations.filter(c => c.id !== deletedId);
  return remaining.length > 0 ? (remaining[0]?.id ?? null) : null;
}

/**
 * Console project chat page supporting multi-conversation sidebar management,
 * message streaming, interactive workflow execution cards, and live thread selection.
 */
export function ChatPage(): ReactElement {
  const { projectId, convId } = useParams<{ projectId: string; convId?: string }>();
  const navigate = useNavigate();

  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );

  const { data: conversations, error: conversationsError } = useEntity<ConversationSummary[]>(
    projectId !== undefined ? K.conversations(projectId) : 'noop:no-project-convs',
    () => (projectId !== undefined ? skill.listConversations(projectId) : Promise.resolve([]))
  );

  const { data: runsData } = useEntity<{ runs: Run[]; counts: RunCounts; total: number }>(
    projectId !== undefined ? K.runs(projectId) : 'noop:no-project-runs',
    () =>
      projectId !== undefined
        ? skill.listRuns({ codebaseId: projectId })
        : Promise.resolve({
            runs: [],
            counts: {
              all: 0,
              running: 0,
              paused: 0,
              failed: 0,
              completed: 0,
              cancelled: 0,
              pending: 0,
            },
            total: 0,
          })
  );

  const workflowConvIds = useMemo(() => {
    const runs = runsData?.runs ?? [];
    return new Set(
      runs.flatMap(r => {
        const runWithWorker = r as Run & {
          worker_platform_id?: string | null;
        };
        return [r.workerPlatformId, runWithWorker.worker_platform_id].filter((id): id is string =>
          Boolean(id)
        );
      })
    );
  }, [runsData]);

  const userChats = useMemo(() => {
    const list = (conversations ?? []).filter(c => {
      if (c.platformType !== 'web') return false;
      const conv = c as ConversationSummary & {
        platformConversationId?: string;
        dbId?: string;
      };
      if (workflowConvIds.has(c.id)) return false;
      if (conv.platformConversationId && workflowConvIds.has(conv.platformConversationId)) {
        return false;
      }
      if (conv.dbId && workflowConvIds.has(conv.dbId)) {
        return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      const timeA = a.lastActivityAt ? new Date(ensureUtc(a.lastActivityAt)).getTime() : 0;
      const timeB = b.lastActivityAt ? new Date(ensureUtc(b.lastActivityAt)).getTime() : 0;
      return timeB - timeA;
    });
  }, [conversations, workflowConvIds]);

  // Active conversation state.
  const [activeConvId, setActiveConvId] = useState<string | null>(convId ?? null);
  const hasInitializedRef = useRef(false);

  // Synchronize when route convId changes.
  useEffect(() => {
    setActiveConvId(convId ?? null);
    if (convId !== undefined) {
      hasInitializedRef.current = true;
    }
  }, [convId]);

  // Initial load auto-select: if no convId in URL and user hasn't interacted, pick the first user chat.
  useEffect(() => {
    if (hasInitializedRef.current) return;
    if (convId !== undefined) {
      hasInitializedRef.current = true;
      return;
    }
    if (userChats.length > 0) {
      hasInitializedRef.current = true;
      const firstId = userChats[0]?.id;
      if (firstId !== undefined) {
        setActiveConvId(firstId);
      }
    }
  }, [convId, userChats]);

  const handleSelectConversation = useCallback(
    (selectedId: string): void => {
      hasInitializedRef.current = true;
      setActiveConvId(selectedId);
      if (projectId !== undefined) {
        navigate(`/console/p/${projectId}/chat/${selectedId}`);
      }
    },
    [navigate, projectId]
  );

  const handleNewChat = useCallback((): void => {
    hasInitializedRef.current = true;
    setActiveConvId(null);
    if (projectId !== undefined) {
      navigate(`/console/p/${projectId}/chat`);
    }
  }, [navigate, projectId]);

  const handleRenameConversation = useCallback(
    async (targetId: string, newTitle: string): Promise<void> => {
      await skill.updateConversationTitle(targetId, newTitle);
      if (projectId !== undefined) {
        invalidate(K.conversations(projectId));
      }
    },
    [projectId]
  );

  const handleDeleteConversation = useCallback(
    async (targetId: string): Promise<void> => {
      await skill.deleteConversation(targetId);
      if (projectId !== undefined) {
        invalidate(K.conversations(projectId));
      }
      invalidate(K.messages(targetId));

      if (activeConvId === targetId) {
        const nextId = resolveNextActiveConversation(targetId, activeConvId, userChats);
        hasInitializedRef.current = true;
        setActiveConvId(nextId);
        if (projectId !== undefined) {
          if (nextId !== null) {
            navigate(`/console/p/${projectId}/chat/${nextId}`);
          } else {
            navigate(`/console/p/${projectId}/chat`);
          }
        }
      }
    },
    [activeConvId, navigate, projectId, userChats]
  );

  const { data: messages, error: messagesError } = useEntity<Message[]>(
    activeConvId !== null ? K.messages(activeConvId) : 'noop:no-conv',
    () => (activeConvId !== null ? skill.listMessages(activeConvId) : Promise.resolve([]))
  );

  // `busy` = a reply is pending → composer disabled + recovery poll active.
  // Driven by message content and the send action, NOT by the SSE lock event,
  // so it stays correct even when the per-conversation SSE drops or never
  // connects (which it can, cross-origin in dev). SSE is a pure accelerator.
  const [runningConvIds, setRunningConvIds] = useState<Set<string>>(new Set());
  const busy = activeConvId !== null && runningConvIds.has(activeConvId);
  const [error, setError] = useState<string | null>(null);
  // Non-error advisory (distinct channel from `error` so it doesn't read as a
  // send failure) — e.g. files dropped from a first message.
  const [notice, setNotice] = useState<string | null>(null);

  // Turn-completion state. The settle timer (below) is the correctness floor — it
  // works even when SSE is absent. The SSE lock event is a fast-path on top of it.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleSigRef = useRef('');

  // SSE accelerator: invalidates the message cache on text/tool events, and via
  // onLockChange clears `busy` the instant the server releases the conversation
  // lock (conversation_lock:false) instead of waiting out SETTLE_MS. Must be
  // useCallback-stable — the hook's effect depends on it, so an inline lambda
  // would reconnect the EventSource on every render.
  const onLockChange = useCallback(
    (locked: boolean): void => {
      if (locked) return;
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      if (activeConvId !== null) {
        setRunningConvIds(prev => {
          const next = new Set(prev);
          next.delete(activeConvId);
          return next;
        });
      }
    },
    [activeConvId]
  );
  useConversationSSE(activeConvId, onLockChange);

  // Derive turn state from the trailing message: a user message means a reply
  // is pending; once an assistant reply lands and stays stable for SETTLE_MS the
  // turn is done. This also recovers a reload mid-turn (trailing user message).
  useEffect(() => {
    const list = messages ?? [];
    const last = list[list.length - 1];
    if (last === undefined) return;
    if (last.role === 'user') {
      settleSigRef.current = '';
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      if (activeConvId !== null) {
        setRunningConvIds(prev => new Set(prev).add(activeConvId));
      }
      return;
    }
    // Trailing message is an assistant/system reply. Arm the settle timer once;
    // re-arm only on real content change so identical poll refetches (same sig)
    // don't reset it forever.
    const sig = `${list.length}:${last.id}`;
    if (sig === settleSigRef.current) return;
    settleSigRef.current = sig;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      if (activeConvId !== null) {
        setRunningConvIds(prev => {
          const next = new Set(prev);
          next.delete(activeConvId);
          return next;
        });
      }
    }, SETTLE_MS);
  }, [messages, activeConvId]);
  useEffect(
    () => (): void => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    []
  );

  // Recovery poll: while a reply is pending, refetch messages on a cadence so a
  // dropped or absent SSE event can't hide the reply. Hard-caps at MAX_WAIT_MS.
  const busySinceRef = useRef(0);
  useEffect(() => {
    if (!busy || activeConvId === null) return;
    busySinceRef.current = Date.now();
    const id = setInterval(() => {
      if (Date.now() - busySinceRef.current > MAX_WAIT_MS) {
        setRunningConvIds(prev => {
          const next = new Set(prev);
          next.delete(activeConvId);
          return next;
        });
        return;
      }
      invalidate(K.messages(activeConvId));
    }, ACTIVE_POLL_MS);
    return (): void => {
      clearInterval(id);
    };
  }, [busy, activeConvId]);

  // Reveal the raw tool trace and system messages inline. Default to true.
  const [showTools, setShowTools] = useState(true);
  const [showSystem, setShowSystem] = useState(true);

  const handleStop = useCallback(async () => {
    if (activeConvId === null) return;
    setError(null);
    try {
      await skill.stopConversationRun(activeConvId);
      setRunningConvIds(prev => {
        const next = new Set(prev);
        next.delete(activeConvId);
        return next;
      });
    } catch (err) {
      console.error('Failed to stop run:', err);
      setError(err instanceof Error ? err.message : 'Failed to stop run. Please try again.');
    }
  }, [activeConvId]);

  const onSend = (text: string, files?: File[]): void => {
    if (projectId === undefined) return;
    setError(null);
    setNotice(null);
    const targetConvId = activeConvId;
    if (targetConvId !== null) {
      setRunningConvIds(prev => new Set(prev).add(targetConvId)); // optimistic: disable the composer immediately
    }
    void (async (): Promise<void> => {
      let createdConvId: string | null = null;
      try {
        if (targetConvId === null) {
          const conv = await skill.createConversation(projectId, text);
          createdConvId = conv.conversationId;
          setRunningConvIds(prev => new Set(prev).add(conv.conversationId));
          hasInitializedRef.current = true;
          setActiveConvId(conv.conversationId);
          navigate(`/console/p/${projectId}/chat/${conv.conversationId}`);
          invalidate(K.conversations(projectId));
          invalidate(K.messages(conv.conversationId));
          // createConversation is JSON-only — files can't ride the first message.
          // Surface it as a non-error notice (not silently dropped); phrased so
          // it's actionable once the agent replies (the composer is locked while
          // `busy`), not "now".
          if (files !== undefined && files.length > 0) {
            setNotice(
              "Files aren't attached to the first message of a new chat — re-attach and send them once the chat has started."
            );
          }
        } else {
          await skill.sendMessage(targetConvId, text, files);
          invalidate(K.messages(targetConvId));
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        const failedConvId = targetConvId ?? createdConvId;
        if (failedConvId !== null) {
          setRunningConvIds(prev => {
            const next = new Set(prev);
            next.delete(failedConvId);
            return next;
          });
        } // unblock so the user can retry
      }
      // On success `busy` stays true until the settle detector sees the reply.
    })();
  };

  const messageList = messages ?? [];

  const toolCallCount = useMemo(
    () => messageList.reduce((acc, m) => acc + (m.toolCalls?.length ?? 0), 0),
    [messageList]
  );

  // Current activity for the working indicator: the latest tool the agent
  // invoked in the in-flight turn (walk back to the last user message).
  const currentActivity = useMemo<string | null>(() => {
    for (let i = messageList.length - 1; i >= 0; i--) {
      const m = messageList[i];
      if (m === undefined) continue;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && m.toolCalls.length > 0) {
        return m.toolCalls[m.toolCalls.length - 1]?.name ?? null;
      }
    }
    return null;
  }, [messageList]);

  // Inline auto-scroll: stick to bottom on new messages if already near it.
  // Mirrors RunDetailPage's variant.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastBottomRef = useRef(true);

  // Track total content length across messages to detect in-place streaming token additions
  const messagesContentLength = useMemo(() => {
    if (!messages) return 0;
    let len = 0;
    for (const m of messages) {
      len += (m.content?.length ?? 0) + (m.toolCalls?.length ?? 0);
      if (m.toolCalls) {
        for (const t of m.toolCalls) {
          len += (t.output?.length ?? 0) + (t.name?.length ?? 0);
        }
      }
    }
    return len;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !lastBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages?.length, messagesContentLength, busy, currentActivity]);

  // Jump-to-bottom affordance: `atBottom` (state) drives the button's visibility;
  // `lastBottomRef` (above) drives the auto-scroll stickiness. Keep them in sync.
  const [atBottom, setAtBottom] = useState(true);
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    lastBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    lastBottomRef.current = true;
    setAtBottom(true);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [activeConvId, scrollToBottom]);

  if (projectId === undefined) {
    return <EmptyState title="No project selected." />;
  }

  // Surface a failed (re)load of the conversation list or message history — a
  // revalidation can fail silently (network blip, server restart) and otherwise
  // leave stale/empty data with no signal. Send errors take precedence.
  const loadError = messagesError ?? conversationsError;

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {project?.name ?? 'Project'}
            </h1>
            <p className="text-xs text-text-tertiary">{project?.path ?? 'Loading…'}</p>
          </div>
        </div>
        <ProjectViewTabs projectId={projectId} active="chat" />
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border/60 bg-surface px-[30px] py-2 text-[11px]">
            <span className="font-mono text-[12px] text-text-tertiary">
              {messageList.length.toString()} messages · {toolCallCount.toString()} tool calls
            </span>
            <div className="flex items-center gap-[18px] font-mono text-[12px]">
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-text-secondary hover:text-text-primary">
                <input
                  type="checkbox"
                  checked={showTools}
                  onChange={e => {
                    setShowTools(e.target.checked);
                  }}
                  className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--accent-bright)]"
                />
                <span>Tool calls</span>
              </label>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-text-secondary hover:text-text-primary">
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={e => {
                    setShowSystem(e.target.checked);
                  }}
                  className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--accent-bright)]"
                />
                <span>System</span>
              </label>
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="h-full overflow-y-auto px-[30px] pt-[26px] pb-[18px]"
            >
              {/* Match the composer's centered 940px column (design: .stream-inner) */}
              <div className="mx-auto max-w-[940px]">
                {messageList.length === 0 && !busy ? (
                  <EmptyState
                    title="No messages yet."
                    hint="Ask the agent about this project, or tell it what to run."
                  />
                ) : (
                  <StreamContextProvider value={{ runStartedAt: null }}>
                    <ChatStream
                      messages={messageList}
                      showTools={showTools}
                      showSystem={showSystem}
                    />
                    {busy ? (
                      <WorkingIndicator
                        activity={currentActivity}
                        expanded={showTools}
                        onToggle={() => {
                          setShowTools(v => !v);
                        }}
                      />
                    ) : null}
                  </StreamContextProvider>
                )}
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

          <WorkflowDock projectId={projectId} />

          {notice !== null ? (
            <div className="shrink-0 border-t border-warning/30 bg-warning/[0.06] px-6 py-2 font-mono text-[11px] text-warning">
              {notice}
            </div>
          ) : null}

          {error !== null || loadError !== undefined ? (
            <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-6 py-2 font-mono text-[11px] text-error">
              {error ?? `Failed to load chat: ${loadError?.message ?? 'unknown error'}`}
            </div>
          ) : null}

          <ChatComposer onSend={onSend} disabled={busy} isRunning={busy} onStop={handleStop} />
        </div>

        <ChatHistoryPanel
          conversations={userChats}
          activeConvId={activeConvId}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleNewChat}
          onRenameConversation={handleRenameConversation}
          onDeleteConversation={handleDeleteConversation}
        />
      </div>
    </section>
  );
}
