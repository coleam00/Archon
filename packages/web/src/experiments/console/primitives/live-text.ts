/**
 * Live assistant text — the part of a reply that has been streamed but not yet
 * written to the database.
 *
 * The server emits each piece of assistant text over SSE the moment it is
 * produced, but it buffers that text in memory and writes it as message rows
 * only at the end of the turn or on a 30-second periodic flush
 * (`adapters/web/persistence.ts`). The console renders from the database, so
 * treating an SSE event purely as "refetch now" asks for a row that does not
 * exist yet: the refetch returns the old list, no further event arrives, and
 * the reply stays invisible until something else triggers a read. That is why a
 * reply could only be revealed by reloading the page.
 *
 * The buffer is deliberately NOT fixed by persisting sooner. Buffered text is
 * provisional: `emitRetract` drops the last segment when the orchestrator's
 * reply turns out to be a workflow dispatch, and it can only do that while the
 * text is still in memory. Writing text early would leave retracted prose in
 * the history forever. So the lateness is load-bearing, and the right place to
 * fix the symptom is the view: show the streamed text immediately, and let the
 * database stay authoritative.
 *
 * These functions mirror the server's segmentation rules so the preview can be
 * matched against the rows that eventually land, without comparing content.
 */

/** Categories the server treats as their own bubble rather than appending to the previous one. */
const STANDALONE_CATEGORIES = ['workflow_status', 'workflow_dispatch_status'] as const;

function isStandalone(category: string | null): boolean {
  return STANDALONE_CATEGORIES.some(c => c === category);
}

/**
 * One streamed segment — the client's mirror of a `BufferedSegment`. Each
 * segment becomes exactly one assistant row when the server flushes, so a
 * count of segments can be matched against a count of rows.
 */
export interface LiveSegment {
  content: string;
  category: string | null;
  /**
   * Whether a tool call has landed in this segment. The server starts a new
   * segment for text that follows a tool call, so the preview must too.
   */
  hasTools: boolean;
}

export type LiveEvent =
  | { kind: 'text'; content: string; category: string | null }
  | { kind: 'tool' }
  | { kind: 'retract' };

/**
 * Fold one streamed event into the segment list.
 *
 * Mirrors `MessagePersistence.appendText`: text extends the current segment
 * unless that segment already holds a tool call, or either side of the join is
 * a standalone category. Tool calls do not open a segment of their own here —
 * a tool-only segment persists with empty content and renders nothing, so
 * counting it would put the preview out of step with the rows.
 *
 * Pure: returns a new array and never mutates its input.
 */
export function reduceLive(segments: LiveSegment[], event: LiveEvent): LiveSegment[] {
  const last = segments[segments.length - 1];

  if (event.kind === 'retract') {
    // Mirrors `retractLastSegment`: a segment that carries tool calls survives
    // with its text cleared, anything else goes.
    if (last === undefined) return segments;
    if (last.hasTools) {
      return [...segments.slice(0, -1), { ...last, content: '' }];
    }
    return segments.slice(0, -1);
  }

  if (event.kind === 'tool') {
    if (last === undefined) return segments;
    if (last.hasTools) return segments;
    return [...segments.slice(0, -1), { ...last, hasTools: true }];
  }

  const needsNewSegment =
    last === undefined ||
    last.hasTools ||
    isStandalone(event.category) ||
    isStandalone(last.category);

  if (needsNewSegment) {
    return [...segments, { content: event.content, category: event.category, hasTools: false }];
  }

  return [...segments.slice(0, -1), { ...last, content: last.content + event.content }];
}

/**
 * How many assistant rows of the current turn are already in the database.
 *
 * Counts back to the last user message, and only rows that carry text — a
 * tool-only row persists with empty content and has no matching segment in the
 * preview. The result is how many leading segments the database has caught up
 * with.
 */
export function persistedSegmentCount(messages: { role: string; content: string }[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'user') break;
    if (m.content.trim().length > 0) count++;
  }
  return count;
}

/**
 * The segments that still need previewing: everything the database has not
 * caught up with yet.
 *
 * Slicing rather than clearing is what makes this self-correcting. If the
 * mirror of the server's segmentation is ever wrong, the error lasts until the
 * next flush and then disappears — the database, not the preview, decides what
 * the history says.
 */
export function pendingSegments(
  segments: LiveSegment[],
  messages: { role: string; content: string }[]
): LiveSegment[] {
  const pending = segments.slice(persistedSegmentCount(messages));
  return pending.filter(s => s.content.trim().length > 0);
}
