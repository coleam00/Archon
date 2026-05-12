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
