import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageList } from '@/components/chat/MessageList';
import { useSSE } from '@/hooks/useSSE';
import { getMessages } from '@/lib/api';
import { ensureUtc, formatDurationMs } from '@/lib/format';
import type { MessageResponse } from '@/lib/api';
import { workflowSSEHandlers } from '@/stores/workflow-store';
import type { ChatMessage, ToolCallDisplay, ErrorDisplay } from '@/lib/types';
import type { ToolEvent } from './WorkflowExecution';

interface WorkflowLogsProps {
  conversationId: string;
  startedAt?: number;
  isRunning?: boolean;
  currentlyExecuting?: { nodeName: string; startedAt: number } | null;
  toolEvents?: ToolEvent[];
  /** Timestamp of the selected node's start — used to scroll the message list. */
  scrollToNodeTimestamp?: number | null;
  /** Incremented on every user node click to trigger scroll. */
  nodeScrollTrigger?: number;
}

function hydrateMessages(
  rows: MessageResponse[],
  startedAt?: number,
  toolEvents?: ToolEvent[]
): ChatMessage[] {
  const hydrated: ChatMessage[] = rows.map(row => {
    let meta: {
      error?: ErrorDisplay;
      toolCalls?: {
        name: string;
        input: Record<string, unknown>;
        output?: string;
        duration?: number;
      }[];
    } = {};
    try {
      meta = JSON.parse(row.metadata) as typeof meta;
    } catch {
      console.warn('[WorkflowLogs] Corrupted message metadata', { messageId: row.id });
    }
    const ts = new Date(ensureUtc(row.created_at)).getTime();
    // Restore tool calls persisted in message metadata (written by persistence.ts flush).
    // This ensures historical tool calls are visible immediately on page load,
    // without waiting for the toolEvents prop from the workflow_events table.
    const persistedTools: ToolCallDisplay[] | undefined = meta.toolCalls?.map((tc, i) => ({
      id: `${row.id}-tool-${String(i)}`,
      name: tc.name,
      input: tc.input,
      output: tc.output,
      duration: tc.duration,
      startedAt: ts,
      isExpanded: false,
    }));
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      error: meta.error,
      toolCalls: persistedTools,
      timestamp: ts,
      isStreaming: false,
    };
  });

  const filtered = startedAt ? hydrated.filter(m => m.timestamp >= startedAt) : hydrated;

  // Attach tool events from workflow_events table to assistant messages.
  //
  // Dedup strategy: Messages may already have tool calls from metadata (persisted by
  // persistence.ts flush). Tool events from workflow_events cover the same tool calls
  // but with different IDs (UUIDs vs msgId-tool-N) and different duration measurements.
  // To avoid duplicates, we match tool events against metadata tool calls by name and
  // timestamp proximity — if a metadata tool call with the same name exists within 60s
  // of the tool event, we consider them the same and skip the event.
  //
  // During active execution before flush, no messages have metadata tool calls, so all
  // tool events attach normally. After flush, metadata is authoritative and tool events
  // are skipped. For partially-flushed state, only unmatched tool events are shown.
  if (toolEvents && toolEvents.length > 0) {
    const assistantMsgs = filtered.filter(m => m.role === 'assistant');

    // Build a lookup of all metadata tool calls for dedup matching.
    // Each entry records the tool name and the message timestamp (approximate start time).
    const metadataTools: { name: string; timestamp: number }[] = [];
    for (const m of assistantMsgs) {
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          metadataTools.push({ name: tc.name, timestamp: tc.startedAt });
        }
      }
    }

    // Track which metadata tools have been "claimed" by a tool event match
    // to prevent one metadata tool from deduping multiple distinct tool events.
    const claimedMetadata = new Set<number>();

    const unattached: ToolCallDisplay[] = [];
    for (const te of toolEvents) {
      const teTimestamp = new Date(ensureUtc(te.createdAt)).getTime();

      // Check if this tool event matches an existing metadata tool call.
      // Match by same name and timestamp within 60s (tool events fire at start,
      // messages are created after completion, so timestamps can differ significantly).
      let isDuplicate = false;
      for (let i = 0; i < metadataTools.length; i++) {
        if (claimedMetadata.has(i)) continue;
        const mt = metadataTools[i];
        if (mt.name === te.name && Math.abs(mt.timestamp - teTimestamp) < 60_000) {
          isDuplicate = true;
          claimedMetadata.add(i);
          break;
        }
      }
      if (isDuplicate) continue;

      // Find the last assistant message that started before this tool event
      let target: ChatMessage | undefined;
      for (const m of assistantMsgs) {
        if (m.timestamp <= teTimestamp) target = m;
        else break;
      }
      if (!target) target = assistantMsgs[0];
      if (target) {
        if (!target.toolCalls) target.toolCalls = [];
        if (!target.toolCalls.some(tc => tc.id === te.id)) {
          target.toolCalls.push({
            id: te.id,
            name: te.name,
            input: te.input,
            startedAt: teTimestamp,
            isExpanded: false,
            duration: te.duration,
          });
        }
      } else {
        // No assistant message to attach to — collect for synthetic message
        unattached.push({
          id: te.id,
          name: te.name,
          input: te.input,
          startedAt: teTimestamp,
          isExpanded: false,
          duration: te.duration,
        });
      }
    }

    // Create a synthetic assistant message for unattached tool events.
    // This handles the case where the persistence buffer hasn't flushed yet
    // during active workflow execution — tool events exist in the DB but
    // the assistant messages containing them haven't been persisted.
    if (unattached.length > 0) {
      const earliestTs = Math.min(...unattached.map(tc => tc.startedAt));
      filtered.push({
        id: `synthetic-tools-${String(earliestTs)}`,
        role: 'assistant',
        content: '',
        toolCalls: unattached,
        timestamp: earliestTs,
        isStreaming: false,
      });
      // Re-sort since we inserted a message
      filtered.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  return filtered;
}

/**
 * Read-only chat view for a workflow's worker conversation.
 * Loads historical messages via React Query polling and streams live updates via SSE.
 */
export function WorkflowLogs({
  conversationId,
  startedAt,
  isRunning,
  currentlyExecuting,
  toolEvents,
  scrollToNodeTimestamp,
  nodeScrollTrigger,
}: WorkflowLogsProps): React.ReactElement {
  const [sseMessages, setSseMessages] = useState<ChatMessage[]>([]);
  const queryClient = useQueryClient();
  const prevIsRunningRef = useRef(isRunning);
  const [gracePolling, setGracePolling] = useState(false);
  const [scrollTrigger, setScrollTrigger] = useState(0);

  // Tick timer for live elapsed display on "currently executing" indicator
  const [, setExecTick] = useState(0);
  useEffect(() => {
    if (!isRunning || !currentlyExecuting) return;
    const interval = setInterval(() => {
      setExecTick(t => t + 1);
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [isRunning, currentlyExecuting]);

  // Poll for messages from DB — 3s while running (or during grace period), disabled when terminal.
  // staleTime: 0 ensures post-completion navigation always fetches fresh data on mount.
  const { data: queryMessages } = useQuery({
    queryKey: ['workflowMessages', conversationId],
    queryFn: async (): Promise<ChatMessage[]> => {
      const rows = await getMessages(conversationId);
      return hydrateMessages(rows, startedAt, toolEvents);
    },
    refetchInterval: isRunning || gracePolling ? 3000 : false,
    staleTime: 0,
  });

  // When workflow transitions from running → terminal, keep polling for 6 more seconds
  // (2 extra cycles) to catch late DB flushes, then do a final invalidation.
  // Also force-scroll to bottom so the user sees the final output.
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      // Finalize any in-flight SSE tool calls that never received tool_result.
      // This is a safety net for when onLockChange fires late or is missed.
      const now = Date.now();
      setSseMessages(prev =>
        prev.map(msg => {
          const hasOpenTool = msg.toolCalls?.some(tc => tc.duration === undefined && !tc.output);
          if (!hasOpenTool && !msg.isStreaming) return msg;
          return {
            ...msg,
            isStreaming: false,
            toolCalls: msg.toolCalls?.map(tc =>
              tc.duration === undefined && !tc.output ? { ...tc, duration: now - tc.startedAt } : tc
            ),
          };
        })
      );

      setGracePolling(true);
      setScrollTrigger(prev => prev + 1);
      const timer = setTimeout(() => {
        setGracePolling(false);
        // Final invalidation to pick up late DB flushes
        void queryClient.invalidateQueries({ queryKey: ['workflowMessages', conversationId] });
        setScrollTrigger(prev => prev + 1);
      }, 6000);
      return (): void => {
        clearTimeout(timer);
      };
    }
    prevIsRunningRef.current = isRunning;
    return undefined;
  }, [isRunning, conversationId, queryClient]);

  // When DB messages arrive, prune SSE messages to avoid duplicates.
  // DB is canonical for completed content. SSE messages may carry both completed
  // tool calls (already in DB after flush) and in-progress ones (not yet in DB).
  // We strip completed tools from SSE messages and drop fully-completed ones.
  // This mirrors ChatInterface's hydration merge pattern.
  useEffect(() => {
    if (!queryMessages || queryMessages.length === 0) return;
    setSseMessages(prev => {
      let changed = false;
      const result: ChatMessage[] = [];
      for (const m of prev) {
        if (m.isStreaming) {
          // Actively streaming text — keep as-is (DB doesn't have this yet)
          result.push(m);
          continue;
        }
        const hasActiveTool = m.toolCalls?.some(tc => tc.duration === undefined && !tc.output);
        if (!hasActiveTool) {
          // All tools complete, not streaming — DB has this, drop it
          changed = true;
          continue;
        }
        // Has at least one in-progress tool — keep only the active tools,
        // strip completed ones that are already in DB via persistence flush.
        const activeTools = (m.toolCalls ?? []).filter(
          tc => tc.duration === undefined && !tc.output
        );
        if (activeTools.length < (m.toolCalls?.length ?? 0)) {
          changed = true;
          result.push({ ...m, toolCalls: activeTools });
        } else {
          result.push(m);
        }
      }
      return changed ? result : prev;
    });
  }, [queryMessages]);

  // Merge DB messages (canonical) with SSE-only messages (live streaming).
  //
  // Strategy: DB is always canonical for persisted content. SSE messages are
  // pruned by the effect above whenever new DB data arrives, so only active
  // (streaming / in-progress) SSE messages remain. This prevents duplicates
  // where both DB and SSE contain the same completed tool calls.
  const messages = useMemo((): ChatMessage[] => {
    const dbMessages = queryMessages ?? [];

    // After workflow completes, use DB only — clean, no duplicates.
    if (!isRunning && !gracePolling) return dbMessages;

    // While running with no SSE data yet, show DB messages.
    if (sseMessages.length === 0) return dbMessages;

    // No DB messages yet — show SSE only.
    if (dbMessages.length === 0) return sseMessages;

    // Collect DB tool calls for dedup against SSE tools.
    // SSE and DB compute durations independently (client vs server Date.now()),
    // so durations can differ by a few ms. We match by name + duration ±500ms.
    const dbTools: { name: string; duration: number }[] = [];
    for (const dm of dbMessages) {
      for (const tc of dm.toolCalls ?? []) {
        if (tc.duration !== undefined) {
          dbTools.push({ name: tc.name, duration: tc.duration });
        }
      }
    }

    const isInDb = (name: string, duration: number): boolean =>
      dbTools.some(dt => dt.name === name && Math.abs(dt.duration - duration) < 500);

    // Collect in-flight SSE tool counts (tool_call received, tool_result not yet received).
    // These are tools SSE is actively tracking with a running spinner.
    // Uses a counted map (not a Set) to handle concurrent same-name tools (e.g., parallel Read calls).
    const sseInFlightCounts = new Map<string, number>();
    for (const m of sseMessages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.duration === undefined && !tc.output) {
          sseInFlightCounts.set(tc.name, (sseInFlightCounts.get(tc.name) ?? 0) + 1);
        }
      }
    }

    // Handle in-flight DB tool calls to prevent duplicates and ordering glitches.
    // When a tool is in-flight, workflow_events has a tool_called row (no duration yet),
    // which hydrateMessages surfaces into queryMessages. Without handling, that DB
    // entry and the SSE entry both appear — the race condition described in issue #744.
    //
    // Two strategies applied:
    // 1. SUPPRESS in-flight DB tools that SSE is actively tracking (cardinality-aware)
    // 2. REPOSITION remaining in-flight DB tools to sort at the end (timestamp bump)
    //    This prevents the ordering glitch where DB's earlier server timestamp causes
    //    in-flight tools to jump above completed SSE tools during the prune timing gap.
    const now = Date.now();
    let filteredDbMessages: ChatMessage[];
    if (sseInFlightCounts.size > 0 || isRunning) {
      const dbSuppressedCounts = new Map<string, number>();
      const mapped = dbMessages.map(m => {
        if (!m.toolCalls?.length) return m; // No tool calls to filter — return as-is
        let messageChanged = false;
        const filteredTools = m.toolCalls.filter(tc => {
          if (tc.duration !== undefined || !!tc.output) return true;
          // In-flight DB tool — suppress if SSE is actively tracking one with this name
          if (sseInFlightCounts.size > 0) {
            const limit = sseInFlightCounts.get(tc.name) ?? 0;
            const suppressed = dbSuppressedCounts.get(tc.name) ?? 0;
            if (suppressed < limit) {
              dbSuppressedCounts.set(tc.name, suppressed + 1);
              return false; // SSE owns this tool's live display
            }
          }
          // In-flight DB tool NOT tracked by SSE — keep it visible but flag for
          // timestamp bump so it sorts at the end instead of jumping above completed tools
          messageChanged = true;
          return true;
        });
        if (filteredTools.length === 0) {
          return { ...m, toolCalls: undefined };
        }
        if (filteredTools.length !== m.toolCalls.length) {
          // Some tools were suppressed. If remaining tools include unsuppressed
          // in-flight ones, bump timestamp so they sort at the end (REPOSITION).
          return { ...m, toolCalls: filteredTools, ...(messageChanged ? { timestamp: now } : {}) };
        }
        // No tools suppressed — if this message has in-flight tools, bump its
        // timestamp so it sorts at the end (matching where SSE would place it)
        if (messageChanged) {
          return { ...m, timestamp: now };
        }
        return m;
      });
      // Preserve memo stability: return original array if nothing was actually filtered
      filteredDbMessages = mapped.every((m, i) => m === dbMessages[i]) ? dbMessages : mapped;
    } else {
      filteredDbMessages = dbMessages;
    }

    // Collect DB text content for dedup against SSE text messages.
    // During live execution, the same text (e.g., "🚀 Starting workflow...") can appear
    // in both DB (from REST fetch on mount) and SSE (from event buffer replay).
    // Without dedup, the text shows up twice in the message list.
    const dbTextContents = new Set<string>();
    for (const dm of filteredDbMessages) {
      if (dm.role === 'assistant' && dm.content) {
        dbTextContents.add(dm.content);
      }
    }

    // Strip SSE tool calls that already appear in DB messages (completed).
    // Also strip SSE text messages that are already in DB (prevents duplicate text).
    const dedupedSse: ChatMessage[] = [];
    for (const m of sseMessages) {
      if (!m.toolCalls?.length) {
        // Skip SSE text-only messages whose content already exists in DB.
        if (m.content && dbTextContents.has(m.content)) {
          continue;
        }
        // Also skip if DB has a message that starts with the SSE content
        // (SSE text was flushed to DB before SSE finished accumulating).
        if (m.content && [...dbTextContents].some(dc => dc.startsWith(m.content))) {
          continue;
        }
        if (m.isStreaming || m.content) dedupedSse.push(m);
        continue;
      }
      const uniqueTools = m.toolCalls.filter(
        tc => tc.duration === undefined || !isInDb(tc.name, tc.duration)
      );
      if (uniqueTools.length > 0 || m.isStreaming || m.content) {
        dedupedSse.push({
          ...m,
          toolCalls: uniqueTools.length > 0 ? uniqueTools : undefined,
        });
      }
    }

    if (dedupedSse.length === 0) return filteredDbMessages;
    const combined = [...filteredDbMessages, ...dedupedSse];
    combined.sort((a, b) => a.timestamp - b.timestamp);
    return combined;
  }, [queryMessages, sseMessages, isRunning, gracePolling]);

  const onText = useCallback((content: string): void => {
    setSseMessages(prev => {
      const last = prev[prev.length - 1];
      // Workflow status messages (🚀 start, ✅ complete) should be their own message,
      // matching ChatInterface's behavior and persistence segmentation. Without this,
      // all text concatenates into one giant streaming message, breaking text dedup
      // against DB messages (which are stored as separate segments).
      const isWorkflowStatus = /^[\u{1F680}\u{2705}]/u.test(content);

      if (last?.role === 'assistant' && last.isStreaming) {
        const lastIsWorkflowStatus = /^[\u{1F680}\u{2705}]/u.test(last.content);

        if ((isWorkflowStatus && last.content) || (lastIsWorkflowStatus && !isWorkflowStatus)) {
          // Close the current streaming message and start a new one when:
          // 1. Incoming is a workflow status and current has content
          // 2. Current is a workflow status and incoming is regular text
          return [
            ...prev.slice(0, -1),
            { ...last, isStreaming: false },
            {
              id: `msg-${String(Date.now())}`,
              role: 'assistant' as const,
              content,
              timestamp: Date.now(),
              isStreaming: true,
              toolCalls: [],
            },
          ];
        }
        return [...prev.slice(0, -1), { ...last, content: last.content + content }];
      }
      return [
        ...prev,
        {
          id: `msg-${String(Date.now())}`,
          role: 'assistant' as const,
          content,
          timestamp: Date.now(),
          isStreaming: true,
          toolCalls: [],
        },
      ];
    });
  }, []);

  const onToolCall = useCallback((name: string, input: Record<string, unknown>): void => {
    setSseMessages(prev => {
      const now = Date.now();
      let last = prev[prev.length - 1];

      // If no assistant message exists yet (tool arrives before any text),
      // create one so the tool card has a home in the message list.
      if (last?.role !== 'assistant') {
        last = {
          id: `msg-${String(now)}`,
          role: 'assistant' as const,
          content: '',
          timestamp: now,
          isStreaming: false,
          toolCalls: [],
        };
        const newTool: ToolCallDisplay = {
          id: `${last.id}-tool-0`,
          name,
          input,
          startedAt: now,
          isExpanded: false,
        };
        return [...prev, { ...last, toolCalls: [newTool] }];
      }

      const updatedExistingTools = (last.toolCalls ?? []).map(tc =>
        !tc.output && tc.duration === undefined ? { ...tc, duration: now - tc.startedAt } : tc
      );
      const newTool: ToolCallDisplay = {
        id: `${last.id}-tool-${String(updatedExistingTools.length)}`,
        name,
        input,
        startedAt: now,
        isExpanded: false,
      };
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          isStreaming: false,
          toolCalls: [...updatedExistingTools, newTool],
        },
      ];
    });
  }, []);

  const onToolResult = useCallback((name: string, output: string, duration: number): void => {
    setSseMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.toolCalls) {
        const updatedTools = last.toolCalls.map(tc =>
          tc.name === name && !tc.output ? { ...tc, output, duration } : tc
        );
        return [...prev.slice(0, -1), { ...last, toolCalls: updatedTools }];
      }
      return prev;
    });
  }, []);

  const onError = useCallback((error: ErrorDisplay): void => {
    setSseMessages(prev => {
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

  const onLockChange = useCallback((isLocked: boolean): void => {
    if (!isLocked) {
      const now = Date.now();
      setSseMessages(prev =>
        prev.map(msg => {
          const needsToolFix = msg.toolCalls?.some(tc => !tc.output && tc.duration === undefined);
          const needsStreamFix = msg.isStreaming;
          if (!needsToolFix && !needsStreamFix) return msg;
          return {
            ...msg,
            isStreaming: false,
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
    }
  }, []);

  const onSessionInfo = useCallback((_sessionId: string, _cost?: number): void => {
    // No-op for read-only view
  }, []);

  useSSE(conversationId, {
    onText,
    onToolCall,
    onToolResult,
    onError,
    onLockChange,
    onSessionInfo,
    ...workflowSSEHandlers,
  });

  // If workflow is running but no message is currently streaming,
  // append a thinking placeholder so the three pulsing dots appear at the bottom.
  const displayMessages = useMemo((): ChatMessage[] => {
    if (!isRunning) return messages;
    const hasActiveStream = messages.some(m => m.isStreaming);
    if (hasActiveStream) return messages;
    return [
      ...messages,
      {
        id: 'workflow-thinking',
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      },
    ];
  }, [messages, isRunning]);

  const isStreaming = displayMessages.some(m => m.isStreaming);

  // Show loading indicator while waiting for first messages
  if (displayMessages.length === 0 && (isRunning || queryMessages === undefined)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-text-tertiary">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-sm">Loading workflow logs...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      {isRunning && currentlyExecuting && (
        <div className="px-4 py-2 bg-surface-secondary border-b border-border flex items-center gap-2 text-sm shrink-0">
          <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="text-text-secondary">Currently executing:</span>
          <span className="font-medium text-text-primary">{currentlyExecuting.nodeName}</span>
          <span className="text-text-tertiary text-xs">
            ({formatDurationMs(Date.now() - currentlyExecuting.startedAt)})
          </span>
        </div>
      )}
      <MessageList
        messages={displayMessages}
        isStreaming={isStreaming}
        scrollTrigger={scrollTrigger}
        scrollToTimestamp={scrollToNodeTimestamp}
        scrollToTrigger={nodeScrollTrigger}
      />
    </div>
  );
}
