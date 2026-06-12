/**
 * Pure reducer functions for the ChatInterface `onText` SSE handler.
 *
 * Extracted so they can be unit-tested independently of the React component.
 * All functions are deterministic: given the same inputs they always produce
 * the same output with no side effects.
 */

import type { ChatMessage } from './types';

/** Regex that identifies workflow-status messages (🚀 / ✅ prefix). */
const WORKFLOW_STATUS_RE = /^[\u{1F680}\u{2705}]/u;

/**
 * Builds a new streaming assistant message.  The `id` is caller-supplied so
 * that tests can produce stable, deterministic IDs.
 */
function makeStreamingMessage(
  id: string,
  content: string,
  timestamp: number,
  isStreaming: boolean,
  workflowResult?: { workflowName: string; runId: string }
): ChatMessage {
  return {
    id,
    role: 'assistant' as const,
    content,
    timestamp,
    isStreaming,
    toolCalls: [],
    ...(workflowResult !== undefined ? { workflowResult } : {}),
  };
}

/**
 * Applies a text SSE event to the current message list.
 *
 * This mirrors (and is called by) the `setMessages` updater inside the
 * `onText` callback of `ChatInterface.tsx`.  Segmentation rules:
 *
 * 1. Workflow-result text → always a new, non-streaming message (deduped by runId).
 * 2. Incoming workflow-status when current has content → close current, open new.
 * 3. Current is workflow-status and incoming is regular text → close current, open new.
 * 4. Current message has tool calls → close current, open new (mirrors persistence.ts:72).
 * 5. Otherwise → append to the current streaming message.
 * 6. No streaming assistant message → create a new one.
 *
 * @param prev        Current message list (treated as immutable).
 * @param content     Text to apply.
 * @param makeId      Factory for generating a new message ID (injectable for testing).
 * @param now         Timestamp to use for new messages (injectable for testing).
 * @param workflowResult  Optional workflow-result metadata carried by the text event.
 */
export function applyOnText(
  prev: ChatMessage[],
  content: string,
  makeId: () => string = () => `msg-${String(Date.now())}`,
  now: number = Date.now(),
  workflowResult?: { workflowName: string; runId: string }
): ChatMessage[] {
  const last = prev[prev.length - 1];
  const isWorkflowStatus = WORKFLOW_STATUS_RE.test(content);

  // Rule 1: workflow-result messages always start as a new non-streaming message.
  // Dedup: SSETransport replays buffered events on reconnect, so skip if already present.
  if (workflowResult !== undefined) {
    if (prev.some(m => m.workflowResult?.runId === workflowResult.runId)) {
      return prev;
    }
    const updated =
      last?.role === 'assistant' && last.isStreaming
        ? [...prev.slice(0, -1), { ...last, isStreaming: false }]
        : [...prev];
    return [...updated, makeStreamingMessage(makeId(), content, now, false, workflowResult)];
  }

  if (last?.role === 'assistant' && last.isStreaming) {
    const lastIsWorkflowStatus = WORKFLOW_STATUS_RE.test(last.content);

    // Rules 2 & 3: workflow-status boundary.
    if ((isWorkflowStatus && last.content) || (lastIsWorkflowStatus && !isWorkflowStatus)) {
      return [
        ...prev.slice(0, -1),
        { ...last, isStreaming: false },
        makeStreamingMessage(makeId(), content, now, true),
      ];
    }

    // Rule 4: text after tool calls starts a new message segment, matching
    // server-side persistence.ts segmentation (persistence.ts:72: lastSeg.toolCalls.length > 0).
    if ((last.toolCalls?.length ?? 0) > 0) {
      return [
        ...prev.slice(0, -1),
        { ...last, isStreaming: false },
        makeStreamingMessage(makeId(), content, now, true),
      ];
    }

    // Rule 5: append to existing streaming message.
    return [...prev.slice(0, -1), { ...last, content: last.content + content }];
  }

  // Rule 6: no active streaming assistant message → create a new one.
  return [...prev, makeStreamingMessage(makeId(), content, now, true)];
}
/**
 * Drops client-only assistant messages whose content already exists in the
 * hydrated DB set. SSE message IDs are synthetic and never match DB UUIDs,
 * so id-based deduplication alone cannot catch an already-persisted streamed
 * reply.
 */
function dropHydratedContentDuplicates(
  clientOnly: ChatMessage[],
  hydrated: ChatMessage[]
): ChatMessage[] {
  const hydratedAssistantContents = new Set(
    hydrated.filter(m => m.role === 'assistant' && m.content).map(m => m.content)
  );
  return clientOnly.filter(
    m =>
      !(
        m.role === 'assistant' &&
        m.content !== '' &&
        m.error === undefined &&
        hydratedAssistantContents.has(m.content)
      )
  );
}

/**
 * Merge REST-hydrated history into the current list on mount.
 * DB is canonical; keeps client-only messages that are still live
 * (system, streaming-with-content, tool calls). Drops client copies whose
 * content the DB already returned (SSE ids never match DB UUIDs, so id-based
 * dedupe alone cannot catch an already-persisted streamed reply).
 */
export function mergeHydratedHistory(
  prev: ChatMessage[],
  hydrated: ChatMessage[],
  sendActive: boolean
): ChatMessage[] {
  if (prev.length === 0) {
    return hydrated;
  }
  // Preserve SSE-only messages: streaming text OR messages with tool calls not yet in DB.
  // Tool-call messages keep isStreaming:true while the stream is active so the
  // loading indicator persists; the toolCalls clause below ensures they also
  // survive hydration regardless of isStreaming state.
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
  let sseOnly = activeSSE.filter(m => !hydratedIds.has(m.id));
  sseOnly = dropHydratedContentDuplicates(sseOnly, hydrated);
  if (sseOnly.length === 0) return hydrated;
  const merged = [...hydrated, ...sseOnly];
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

/**
 * Merge REST-hydrated history after the stuck-placeholder recovery refetch.
 * Same dedupe rules; preserves the timestamp-interleave insertion order.
 */
export function mergeRecoveredHistory(prev: ChatMessage[], hydrated: ChatMessage[]): ChatMessage[] {
  const hydratedIds = new Set(hydrated.map(m => m.id));
  // Keep only meaningful client-only messages not present in hydrated set.
  // Exclude optimistic user rows and empty thinking placeholders.
  let clientOnly = prev.filter(m => {
    if (hydratedIds.has(m.id)) return false;
    if (m.role === 'system') return true;
    if (m.role !== 'assistant') return false;
    return (
      Boolean(m.content) ||
      Boolean(m.error) ||
      Boolean(m.workflowDispatch) ||
      Boolean(m.workflowResult) ||
      Boolean(m.toolCalls?.length)
    );
  });
  clientOnly = dropHydratedContentDuplicates(clientOnly, hydrated);
  if (clientOnly.length === 0) return hydrated;
  // Interleave client-only messages at their original positions by timestamp
  const merged = [...hydrated];
  for (const msg of clientOnly) {
    const insertIdx = merged.findIndex(m => m.timestamp > msg.timestamp);
    if (insertIdx === -1) merged.push(msg);
    else merged.splice(insertIdx, 0, msg);
  }
  return merged;
}
