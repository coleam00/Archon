/**
 * Pure reducer functions for the ChatInterface `onText` SSE handler.
 *
 * Extracted so they can be unit-tested independently of the React component.
 * All functions are deterministic: given the same inputs they always produce
 * the same output with no side effects.
 */

import type { ChatMessage, MessageCategory, TextEventMeta } from './types';

/**
 * Whether a message is workflow-status narration that deserves its own bubble.
 *
 * The client-side counterpart to the `isWorkflowStatus` check in the web
 * adapter's `MessagePersistence.appendText` — both answer the same question
 * about the same message, so they must name the same categories. The category
 * arrives on the `text` SSE event; a message without one is agent prose.
 */
export function isWorkflowStatusCategory(category: MessageCategory | undefined): boolean {
  return category === 'workflow_status' || category === 'workflow_dispatch_status';
}

/**
 * Whether an incoming `text` event must close the batch `useSSE` is currently
 * accumulating.
 *
 * The hook coalesces text over a 50 ms window and hands the result to
 * `applyOnText` as ONE segment, so a batch can carry only one identity: one
 * category and one finished run. When either differs, the buffered text belongs
 * to a different message and has to go out first.
 *
 * Extracted from the hook so the decision is unit-testable — `@archon/web` has
 * no DOM harness and `EventSource` does not exist under Bun, so nothing inside
 * `useSSE` itself can be exercised directly.
 */
export function startsNewTextBatch(buffered: TextEventMeta, incoming: TextEventMeta): boolean {
  return (
    buffered.category !== incoming.category ||
    buffered.workflowResult?.runId !== incoming.workflowResult?.runId
  );
}

/**
 * Builds a new streaming assistant message.  The `id` is caller-supplied so
 * that tests can produce stable, deterministic IDs.
 */
function makeStreamingMessage(
  id: string,
  content: string,
  timestamp: number,
  isStreaming: boolean,
  meta: TextEventMeta = {}
): ChatMessage {
  return {
    id,
    role: 'assistant' as const,
    content,
    timestamp,
    isStreaming,
    toolCalls: [],
    ...(meta.category !== undefined ? { category: meta.category } : {}),
    ...(meta.workflowResult !== undefined ? { workflowResult: meta.workflowResult } : {}),
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
 * "Workflow-status" is decided by `isWorkflowStatusCategory` on the event's
 * server-supplied `category`, never by inspecting the text.
 *
 * @param prev        Current message list (treated as immutable).
 * @param content     Text to apply.
 * @param makeId      Factory for generating a new message ID (injectable for testing).
 * @param now         Timestamp to use for new messages (injectable for testing).
 * @param meta        Server-supplied metadata from the text event (category,
 *                    workflow-result). Absent `category` means agent prose.
 */
export function applyOnText(
  prev: ChatMessage[],
  content: string,
  makeId: () => string = () => `msg-${String(Date.now())}`,
  now: number = Date.now(),
  meta: TextEventMeta = {}
): ChatMessage[] {
  const last = prev[prev.length - 1];
  const isWorkflowStatus = isWorkflowStatusCategory(meta.category);
  const { workflowResult } = meta;

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
    return [...updated, makeStreamingMessage(makeId(), content, now, false, meta)];
  }

  if (last?.role === 'assistant' && last.isStreaming) {
    const lastIsWorkflowStatus = isWorkflowStatusCategory(last.category);

    // Rules 2 & 3: workflow-status boundary.
    if ((isWorkflowStatus && last.content) || (lastIsWorkflowStatus && !isWorkflowStatus)) {
      return [
        ...prev.slice(0, -1),
        { ...last, isStreaming: false },
        makeStreamingMessage(makeId(), content, now, true, meta),
      ];
    }

    // Rule 4: text after tool calls starts a new message segment, matching
    // server-side persistence.ts segmentation (persistence.ts:72: lastSeg.toolCalls.length > 0).
    if ((last.toolCalls?.length ?? 0) > 0) {
      return [
        ...prev.slice(0, -1),
        { ...last, isStreaming: false },
        makeStreamingMessage(makeId(), content, now, true, meta),
      ];
    }

    // Rule 5: append to existing streaming message.
    //
    // A message can start life without a category: `ChatInterface` pushes an
    // empty "thinking" placeholder the moment the user sends, and the guard in
    // Rules 2 & 3 lets text fall through into it (`last.content` is ''). The
    // first text to land therefore defines what that message is — adopt its
    // category, or the *next* event's trailing-boundary check reads `undefined`
    // and merges prose into what is really a workflow-status bubble.
    return [
      ...prev.slice(0, -1),
      {
        ...last,
        content: last.content + content,
        ...(last.category === undefined && meta.category !== undefined
          ? { category: meta.category }
          : {}),
      },
    ];
  }

  // Rule 6: no active streaming assistant message → create a new one.
  return [...prev, makeStreamingMessage(makeId(), content, now, true, meta)];
}
