import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Header } from '@/components/layout/Header';
import { MessageList } from './MessageList';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { LockIndicator } from './LockIndicator';
import { useSSE } from '@/hooks/useSSE';
import {
  useWorkflowStore,
  selectActiveWorkflow,
  workflowSSEHandlers,
} from '@/stores/workflow-store';
import {
  sendMessage as apiSendMessage,
  listConversations,
  listCodebases,
  getMessages,
  createConversation,
  getWorkflowRunByWorker,
  getHealth,
} from '@/lib/api';
import type { ConversationResponse, CodebaseResponse, MessageResponse } from '@/lib/api';
import type {
  ChatMessage,
  FileAttachment,
  ToolCallDisplay,
  ErrorDisplay,
  WorkflowDispatchEvent,
} from '@/lib/types';
import { applyOnText } from '@/lib/chat-message-reducer';
import {
  getCachedMessages,
  setCachedMessages,
  isSendInFlight,
  setSendInFlight,
} from '@/lib/message-cache';
import { useProject } from '@/contexts/ProjectContext';
import { ensureUtc } from '@/lib/format';

function mapMessageRow(row: MessageResponse): ChatMessage {
  let meta: {
    toolCalls?: {
      name: string;
      input: Record<string, unknown>;
      duration?: number;
      output?: string;
    }[];
    error?: ErrorDisplay;
    workflowDispatch?: { workerConversationId: string; workflowName: string };
    workflowResult?: { workflowName: string; runId: string };
    files?: { id?: string; name: string; mimeType: string; size: number }[];
  } = {};
  try {
    meta = JSON.parse(row.metadata) as typeof meta;
  } catch (parseErr) {
    // Intentional fallback: render an error card rather than crashing the message list
    console.warn('[Chat] Corrupted message metadata', {
      messageId: row.id,
      error: (parseErr as Error).message,
    });
    meta = {
      error: {
        message: 'Message data corrupted',
        classification: 'fatal' as const,
        suggestedActions: [],
      },
    };
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolCalls: meta.toolCalls?.map((tc, i) => ({
      ...tc,
      id: `${row.id}-tool-${String(i)}`,
      startedAt: 0,
      isExpanded: false,
      duration: tc.duration ?? 0,
    })),
    error: meta.error,
    workflowDispatch: meta.workflowDispatch,
    workflowResult: meta.workflowResult,
    files: Array.isArray(meta.files)
      ? meta.files
          .filter(f => typeof f.name === 'string' && typeof f.mimeType === 'string')
          .map((f, i) => ({
            id: f.id ?? `${row.id}-file-${String(i)}`,
            name: f.name,
            mimeType: f.mimeType,
            size: typeof f.size === 'number' ? f.size : 0,
          }))
      : undefined,
    timestamp: new Date(ensureUtc(row.created_at)).getTime(),
    isStreaming: false,
  };
}

interface ChatInterfaceProps {
  conversationId: string;
}

export function ChatInterface({ conversationId }: ChatInterfaceProps): React.ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedProjectId } = useProject();
  const hasTriggeredTitleRefresh = useRef(false);
  const isNewChat = conversationId === 'new';
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    isNewChat ? [] : getCachedMessages(conversationId)
  );
  const [locked, setLocked] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | undefined>();
  const [sending, setSending] = useState(false);
  const [hasSentMessage, setHasSentMessage] = useState(() => isSendInFlight());
  const inputRef = useRef<MessageInputHandle>(null);
  const messageIdCounter = useRef(0);
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const activeWorkflow = useWorkflowStore(selectActiveWorkflow);
  const hydrateWorkflow = useWorkflowStore(s => s.hydrateWorkflow);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  // Default to true (hide button) until server confirms non-Docker — prevents broken vscode:// links
  const isDocker = health?.is_docker ?? true;

  // Sync messages to cache for persistence across navigation
  useEffect(() => {
    if (!isNewChat) {
      setCachedMessages(conversationId, messages);
    }
  }, [conversationId, messages, isNewChat]);

  // Load message history from server on mount (survives hard refresh).
  // Uses a cancelled flag so StrictMode's unmount/remount cycle discards
  // the stale first fetch, preventing duplicate messages.
  useEffect(() => {
    if (isNewChat) return;
    let cancelled = false;
    void getMessages(conversationId)
      .then((rows: MessageResponse[]) => {
        if (cancelled || rows.length === 0) return;
        const hydrated: ChatMessage[] = rows.map(mapMessageRow);
        // REST is the source of truth for all completed messages.
        // Keep actively streaming messages that have content (AI is generating).
        // Discard empty thinking placeholders ONLY if we're not currently sending —
        // a send in progress means the placeholder was just created for the current
        // request and should be preserved until the first SSE text event arrives.
        // Uses a module-level flag (isSendInFlight) rather than a component ref
        // because navigate() after new-chat creation causes a full remount, and
        // refs don't survive across mount boundaries.
        setMessages(prev => {
          if (prev.length === 0) {
            return hydrated;
          }
          const sendActive = isSendInFlight();
          // Preserve SSE-only messages: streaming text OR messages with tool calls not yet in DB.
          // Tool-call messages keep isStreaming:true while the stream is active so the
          // loading indicator persists; the toolCalls clause below ensures they also
          // survive hydration regardless of isStreaming state.
          // Note: dedup below relies on SSE messages using 'msg-{timestamp}' IDs that
          // never match DB-assigned IDs. Keep SSE IDs synthetic to preserve this invariant.
          const activeSSE = prev.filter(
            m =>
              m.role === 'system' ||
              (m.isStreaming && (m.content || sendActive)) ||
              (m.toolCalls && m.toolCalls.length > 0)
          );
          if (activeSSE.length === 0) return hydrated;
          // Merge: DB is canonical, append SSE-only messages that aren't yet in DB.
          // Identify which SSE messages are already covered by hydrated DB data to avoid dupes.
          const hydratedIds = new Set(hydrated.map(m => m.id));
          const sseOnly = activeSSE.filter(m => !hydratedIds.has(m.id));
          if (sseOnly.length === 0) return hydrated;
          const merged = [...hydrated, ...sseOnly];
          merged.sort((a, b) => a.timestamp - b.timestamp);
          return merged;
        });
        setHasSentMessage(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('[Chat] Failed to load message history', {
          conversationId,
          error: e instanceof Error ? e.message : e,
        });
        setMessages(prev => [
          ...prev,
          {
            id: `error-load-history-${String(Date.now())}`,
            role: 'assistant' as const,
            content: '',
            error: {
              message: 'Failed to load message history. Try refreshing the page.',
              classification: 'transient' as const,
              suggestedActions: ['Refresh page'],
            },
            timestamp: Date.now(),
          },
        ]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [conversationId, isNewChat]);

  // Memoize dispatch IDs as a joined string so the hydration effect only re-fires
  // when a new workflow is dispatched, not on every streaming token.
  const workflowDispatchIds = useMemo(
    () =>
      messages
        .map(m => m.workflowDispatch?.workerConversationId)
        .filter((id): id is string => Boolean(id))
        .join(','),
    [messages]
  );

  // Hydrate workflow status from message metadata when SSE events were missed.
  // workflowDispatch metadata is persisted in DB messages — scan for it after
  // loading history and fetch the workflow run status via REST.
  useEffect(() => {
    if (isNewChat || !workflowDispatchIds) return;
    const ids = workflowDispatchIds.split(',');
    // Only hydrate the most recent dispatch (typical case: one active workflow per chat)
    const latestId = ids[ids.length - 1];
    void getWorkflowRunByWorker(latestId)
      .then(result => {
        if (!result?.run) return;
        const run = result.run;
        hydrateWorkflow({
          runId: run.id,
          workflowName: run.workflow_name,
          status: run.status,
          dagNodes: [],
          artifacts: [],

          startedAt: new Date(ensureUtc(run.started_at)).getTime(),
          completedAt: run.completed_at
            ? new Date(ensureUtc(run.completed_at)).getTime()
            : undefined,
        });
      })
      .catch((err: unknown) => {
        console.warn('[Chat] Failed to hydrate workflow status from message metadata', {
          workerConversationId: latestId,
          error: err instanceof Error ? err.message : err,
        });
      });
  }, [workflowDispatchIds, isNewChat, hydrateWorkflow]);

  // Share conversations cache with sidebar for title/context display
  const { data: conversations, isError: conversationsError } = useQuery<ConversationResponse[]>({
    queryKey: ['conversations'],
    queryFn: () => listConversations(),
  });
  const { data: codebases, isError: codebasesError } = useQuery<CodebaseResponse[]>({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });
  const currentConv = conversations?.find(c => c.platform_conversation_id === conversationId);
  const currentCodebase = codebases?.find(cb => cb.id === currentConv?.codebase_id);
  // Fall back to selectedProjectId codebase for header before conversation exists in DB
  const contextCodebase =
    !currentCodebase && selectedProjectId
      ? codebases?.find(cb => cb.id === selectedProjectId)
      : undefined;
  const headerTitle = currentConv?.title ?? 'Chat';
  const headerSubtitle = currentConv?.cwd ?? undefined;

  const nextId = (): string => {
    messageIdCounter.current += 1;
    return `msg-${String(messageIdCounter.current)}`;
  };

  const onText = useCallback(
    (content: string, workflowResult?: { workflowName: string; runId: string }): void => {
      // First AI text received — the thinking placeholder is about to gain content,
      // so the hydration merge no longer needs the sendInFlight guard.
      setSendInFlight(false);
      setMessages(prev => applyOnText(prev, content, undefined, undefined, workflowResult));
    },
    []
  );

  const onToolCall = useCallback(
    (name: string, input: Record<string, unknown>, toolCallId?: string): void => {
      setMessages(prev => {
        const now = Date.now();
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          // Mark any previous running tools as complete (agent moved on)
          const updatedExistingTools = (last.toolCalls ?? []).map(tc =>
            !tc.output && tc.duration === undefined ? { ...tc, duration: now - tc.startedAt } : tc
          );
          const newTool: ToolCallDisplay = {
            id: toolCallId ?? `${last.id}-tool-${String(updatedExistingTools.length)}`,
            name,
            input,
            startedAt: now,
            isExpanded: false,
          };
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              isStreaming: true,
              toolCalls: [...updatedExistingTools, newTool],
            },
          ];
        }
        // No assistant message to attach to (e.g. REST hydration replaced state with only
        // user messages before this SSE event arrived). Create a synthetic one — mirrors
        // the WorkflowLogs.tsx pattern (lines 354-371).
        const newTool: ToolCallDisplay = {
          id: toolCallId ?? `msg-${String(now)}-tool-0`,
          name,
          input,
          startedAt: now,
          isExpanded: false,
        };
        return [
          ...prev,
          {
            id: `msg-${String(now)}`,
            role: 'assistant' as const,
            content: '',
            timestamp: now,
            isStreaming: true,
            toolCalls: [newTool],
          },
        ];
      });
    },
    []
  );

  const onToolResult = useCallback(
    (name: string, output: string, duration: number, toolCallId?: string): void => {
      setMessages(prev => {
        // Search all messages (not just last) — tool_result may arrive after a text message
        let targetIdx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === 'assistant' && prev[i].toolCalls?.length) {
            // Match by toolCallId if available, otherwise fall back to name-based matching
            const hasMatch = prev[i].toolCalls?.some(
              tc =>
                (toolCallId ? tc.id === toolCallId : tc.name === name) && tc.duration === undefined
            );
            if (hasMatch) {
              targetIdx = i;
              break;
            }
          }
        }
        if (targetIdx === -1) return prev;
        const msg = prev[targetIdx];
        const updatedTools = msg.toolCalls?.map(tc => {
          if (toolCallId ? tc.id === toolCallId : tc.name === name && tc.duration === undefined) {
            return { ...tc, output: output !== undefined ? output : tc.output, duration };
          }
          return tc;
        });
        return [
          ...prev.slice(0, targetIdx),
          { ...msg, toolCalls: updatedTools },
          ...prev.slice(targetIdx + 1),
        ];
      });
    },
    []
  );

  const onError = useCallback((error: ErrorDisplay): void => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, isStreaming: false, error }];
      }
      return [
        ...prev,
        {
          id: `msg-${String(Date.now())}`,
          role: 'assistant',
          content: '',
          error,
          timestamp: Date.now(),
        },
      ];
    });
  }, []);

  const onLockChange = useCallback((isLocked: boolean, position?: number): void => {
    setLocked(isLocked);
    setQueuePosition(position);
    if (!isLocked) {
      const now = Date.now();
      // AI processing is done (lock released) — always clear the sendInFlight guard.
      // This must be unconditional: if it's only cleared inside hasStuckPlaceholder,
      // the flag stays true after workflow dispatches (where the placeholder is replaced
      // by status text), causing ghost streaming messages on the second send.
      setSendInFlight(false);
      // Mark streaming messages with content as complete and fix running tools.
      // Empty thinking placeholders (isStreaming: true, content: '') are intentionally
      // skipped — they indicate the AI hasn't started streaming yet. On the first message
      // of a new conversation, navigate() causes a component remount and a fresh SSE
      // connection; if text events were emitted before the connection established, only
      // the lock-release event is received. We detect this race and re-fetch via REST.
      // Read current messages from ref (stable closure-safe snapshot) to avoid
      // side effects inside the state updater (which React may call twice in StrictMode).
      const hasStuckPlaceholder = messagesRef.current.some(m => m.isStreaming && !m.content);
      setMessages(prev =>
        prev.map(msg => {
          const needsToolFix = msg.toolCalls?.some(tc => !tc.output && tc.duration === undefined);
          const needsStreamFix = msg.isStreaming && !!msg.content; // Skip empty placeholders
          if (!needsToolFix && !needsStreamFix) return msg;
          return {
            ...msg,
            isStreaming: needsStreamFix ? false : msg.isStreaming,
            toolCalls: needsToolFix
              ? msg.toolCalls?.map(tc =>
                  !tc.output && tc.duration === undefined
                    ? { ...tc, duration: now - tc.startedAt }
                    : tc
                )
              : msg.toolCalls,
          };
        })
      );
      // If a thinking placeholder is stuck (text events were missed due to SSE connection
      // timing on first message), fetch the completed response from REST to populate it.
      if (hasStuckPlaceholder) {
        const cid = conversationIdRef.current;
        void getMessages(cid)
          .then((rows: MessageResponse[]) => {
            if (rows.length === 0) return;
            const hydrated = rows.map(mapMessageRow);
            // Merge hydrated DB messages with client-only state (system, live SSE) to
            // avoid losing messages that exist only on the client.
            setMessages(prev => {
              const hydratedIds = new Set(hydrated.map(m => m.id));
              // Keep any client-only messages (system, SSE-only) not present in hydrated set
              const clientOnly = prev.filter(m => !hydratedIds.has(m.id));
              if (clientOnly.length === 0) return hydrated;
              // Interleave client-only messages at their original positions by timestamp
              const merged = [...hydrated];
              for (const msg of clientOnly) {
                const insertIdx = merged.findIndex(m => m.timestamp > msg.timestamp);
                if (insertIdx === -1) merged.push(msg);
                else merged.splice(insertIdx, 0, msg);
              }
              return merged;
            });
          })
          .catch((err: unknown) => {
            console.error(
              '[Chat] Re-fetch after SSE reconnect failed — clearing stuck placeholder',
              {
                conversationId: conversationIdRef.current,
                error: err instanceof Error ? err.message : err,
              }
            );
            // Re-fetch failed — clear stuck placeholder so user can retry
            setMessages(prev =>
              prev.map(m => (m.isStreaming && !m.content ? { ...m, isStreaming: false } : m))
            );
          });
      }
    }
  }, []);

  // Safety net: when the active workflow transitions to terminal status, ensure
  // locked state is cleared and streaming messages are finalized. Handles cases
  // where conversation_lock:false and workflow_status:completed SSE events were
  // lost (e.g., user navigated away during workflow execution and came back).
  const prevWorkflowStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = activeWorkflow?.status;
    const prevStatus = prevWorkflowStatusRef.current;
    prevWorkflowStatusRef.current = status;
    if (
      status &&
      status !== prevStatus &&
      (status === 'completed' || status === 'failed' || status === 'cancelled')
    ) {
      onLockChange(false);
    }
  }, [activeWorkflow?.status, onLockChange]);

  const onSessionInfo = useCallback((_sessionId: string, _cost?: number): void => {
    // Session info can be stored for display later
  }, []);

  const onWorkflowDispatch = useCallback((event: WorkflowDispatchEvent): void => {
    setMessages(prev => {
      let lastAssistantIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'assistant') {
          lastAssistantIdx = i;
          break;
        }
      }
      if (lastAssistantIdx < 0) return prev;
      const msg = prev[lastAssistantIdx];
      return [
        ...prev.slice(0, lastAssistantIdx),
        {
          ...msg,
          workflowDispatch: {
            workerConversationId: event.workerConversationId,
            workflowName: event.workflowName,
          },
        },
        ...prev.slice(lastAssistantIdx + 1),
      ];
    });
  }, []);

  const onRetract = useCallback((): void => {
    setMessages(prev => {
      // Remove the last assistant message (the retracted router text)
      const lastIdx = prev.length - 1;
      if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
        return prev.slice(0, lastIdx);
      }
      return prev;
    });
  }, []);

  const onWarning = useCallback(
    (message: string): void => {
      console.warn('[SSE] Warning from server:', message);
      onError({
        message,
        classification: 'transient',
        suggestedActions: [],
      });
    },
    [onError]
  );

  const onSystemStatus = useCallback((content: string): void => {
    setMessages(prev => [
      ...prev,
      {
        id: nextId(),
        role: 'system' as const,
        content,
        timestamp: Date.now(),
      },
    ]);
  }, []);

  const { connected } = useSSE(isNewChat ? null : conversationId, {
    onText,
    onToolCall,
    onToolResult,
    onError,
    onLockChange,
    onSessionInfo,
    onWorkflowDispatch,
    onWarning,
    onRetract,
    onSystemStatus,
    ...workflowSSEHandlers,
  });

  const handleSend = useCallback(
    async (message: string, uploadedFiles?: File[]): Promise<void> => {
      // Build lightweight attachment metadata for optimistic UI display
      const fileAttachments: FileAttachment[] | undefined =
        uploadedFiles && uploadedFiles.length > 0
          ? uploadedFiles.map(f => ({
              id: crypto.randomUUID(),
              name: f.name,
              mimeType: f.type,
              size: f.size,
            }))
          : undefined;

      // Add user message + thinking indicator to UI immediately
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        files: fileAttachments,
      };
      const thinkingMsg: ChatMessage = {
        id: `thinking-${String(Date.now())}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      };
      setMessages(prev => [...prev, userMsg, thinkingMsg]);
      setSendInFlight(true);
      setSending(true);
      setHasSentMessage(true);

      let targetConversationId = conversationId;

      // Create conversation on first message if this is a new chat
      // Uses atomic create+message to avoid ghost "Untitled conversation" entries
      if (isNewChat) {
        try {
          const { conversationId: newId } = await createConversation(
            selectedProjectId ?? undefined,
            message
          );
          targetConversationId = newId;
          // Cache messages under the new ID so the remounted ChatInterface picks them up
          // (navigate changes the key prop, causing unmount/remount — state is lost otherwise)
          setCachedMessages(newId, [userMsg, thinkingMsg]);
          navigate(`/chat/${newId}`, { replace: true });
          // Trigger title + workflow refreshes after AI generates a proper title
          if (!hasTriggeredTitleRefresh.current && !message.startsWith('/')) {
            hasTriggeredTitleRefresh.current = true;
            setTimeout(() => {
              void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            }, 2000);
          }
          void queryClient.invalidateQueries({ queryKey: ['workflow-runs-status'] });
          void queryClient.invalidateQueries({ queryKey: ['workflowRuns'] });
          setSending(false);
          return;
        } catch (error) {
          console.error('[Chat] Failed to create conversation', { error });
          onError({
            message: 'Failed to create conversation. Please try again.',
            classification: 'transient',
            suggestedActions: ['Retry'],
          });
          setSendInFlight(false);
          setSending(false);
          return;
        }
      }

      try {
        await apiSendMessage(targetConversationId, message, uploadedFiles);
        // Invalidate conversations cache once after first non-command message
        // so the auto-generated title appears in the sidebar immediately
        if (!hasTriggeredTitleRefresh.current && !message.startsWith('/')) {
          hasTriggeredTitleRefresh.current = true;
          setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }, 2000);
        }
        // Invalidate workflow run queries so sidebar pulsating dot and dashboard
        // update promptly without waiting for the 10-second polling interval
        void queryClient.invalidateQueries({ queryKey: ['workflow-runs-status'] });
        void queryClient.invalidateQueries({ queryKey: ['workflowRuns'] });
      } catch (error) {
        console.error('[Chat] Failed to send message', { error });
        // Extract server error details from fetchJSON errors (e.g. "API error 400 (...): File ... exceeds...")
        const errMsg = error instanceof Error ? error.message : undefined;
        const userMessage =
          errMsg && /API error 4\d\d/.test(errMsg)
            ? errMsg.replace(/^API error \d+ \([^)]*\): /, '')
            : 'Failed to send message. Please try again.';
        onError({
          message: userMessage,
          classification: 'transient',
          suggestedActions: ['Retry'],
        });
      } finally {
        // Only clear sending UI state here. Do NOT clear setSendInFlight —
        // it must stay true until onText fires (first SSE text) or the
        // hasStuckPlaceholder recovery runs on lock release. Clearing it
        // here causes a race: the new mount's REST hydration may run after
        // this finally block, find sendInFlight=false, and discard the
        // thinking placeholder before any SSE text arrives.
        setSending(false);
      }
    },
    [conversationId, isNewChat, navigate, onError, selectedProjectId, queryClient]
  );

  const isStreaming = messages.some(m => m.isStreaming);

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <Header
        title={isNewChat ? 'New Chat' : headerTitle}
        subtitle={headerSubtitle}
        projectName={currentCodebase?.name ?? contextCodebase?.name}
        connected={isNewChat ? undefined : connected}
        isDocker={isDocker}
      />
      {(conversationsError || codebasesError) && (
        <div className="flex gap-2 px-4 py-1">
          {conversationsError && (
            <span className="text-xs text-red-400">Failed to load conversations</span>
          )}
          {codebasesError && <span className="text-xs text-red-400">Failed to load projects</span>}
        </div>
      )}
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        isNewChat={isNewChat}
        projectName={currentCodebase?.name ?? contextCodebase?.name}
        onQuickAction={(action): void => {
          if (action === 'focus') {
            inputRef.current?.focus();
          } else {
            void handleSend(action);
          }
        }}
      />
      <LockIndicator locked={locked && hasSentMessage} queuePosition={queuePosition} />
      <MessageInput
        ref={inputRef}
        onSend={handleSend}
        disabled={
          sending ||
          locked ||
          isStreaming ||
          (currentConv != null && currentConv.platform_type !== 'web')
        }
        disabledReason={
          currentConv != null && currentConv.platform_type !== 'web'
            ? 'Continuing chats from other platforms in the Web UI is coming soon'
            : undefined
        }
      />
    </div>
  );
}
