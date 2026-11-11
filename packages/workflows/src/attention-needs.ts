/**
 * What each line of the attention stream (`attention-watch.ts`) asks of whoever reads it,
 * and the levels a watcher picks lines by. One classifier decides, for every surface.
 */
import { z } from 'zod';
import { attentionStreamLineSchema, type AttentionStreamLine } from './attention-watch';

/** What a stream line asks of whoever reads it. */
export const attentionNeedsSchema = z.enum(['answer', 'look', 'nothing']);
export type AttentionNeeds = z.infer<typeof attentionNeedsSchema>;

/** A stream line as a watcher receives it: the line and what it asks of its reader. */
export const classifiedAttentionStreamLineSchema = attentionStreamLineSchema.and(
  z.object({ needs: attentionNeedsSchema })
);
export type ClassifiedAttentionStreamLine = AttentionStreamLine & { needs: AttentionNeeds };

/**
 * The one rule for what each stream line asks of its reader. A fresh classifier per
 * stream answers, line by line:
 * - `answer`: an item that takes an answer.
 * - `look`: an item nothing can describe; the close of an item that needed someone, so
 *   nobody keeps working on an ask that was answered or moved; a usage-limit wait that
 *   replaces such an item; a run that failed, completed with a failed outcome, or lost
 *   its owner; and a stream that lost coverage or ended.
 * - `nothing`: what happened to work that nobody has to act on (a run completed, was
 *   cancelled or resumed; a usage-limit wait, which continues by itself, opened or
 *   closed), and the lines only a program syncing the full protocol reads.
 *
 * `resumed` is for a stream that continues an earlier one from a cursor. The classifier
 * did not see which items that earlier stream held, so every close is a `look`: telling
 * a reader that an item it never held has closed is harmless, and calling the close of
 * one it holds `nothing` leaves it working on an ask that is gone.
 */
export function attentionLineClassifier(
  options: { resumed?: boolean } = {}
): (line: AttentionStreamLine) => ClassifiedAttentionStreamLine {
  const held = new Set<string>();
  const needsOf = (line: AttentionStreamLine): AttentionNeeds => {
    switch (line.type) {
      case 'attention':
        switch (line.item.kind) {
          case 'attention':
          case 'awaiting_response':
            held.add(line.item.runId);
            return 'answer';
          case 'unreadable':
            held.add(line.item.runId);
            return 'look';
          case 'usage_limit':
            return held.delete(line.item.runId) ? 'look' : 'nothing';
        }
        return line.item satisfies never;
      case 'resolved':
      case 'unmatched':
        return held.delete(line.runId) || options.resumed === true ? 'look' : 'nothing';
      case 'terminal':
        // A run that ran to the end and judged its work unsuccessful needs a look too.
        return line.status === 'failed' || line.outcome === 'failed' ? 'look' : 'nothing';
      case 'owner_lost':
      case 'degraded':
      case 'error':
        return 'look';
      case 'resumed':
      case 'ready':
      case 'bookmark':
        return 'nothing';
    }
    return line satisfies never;
  };
  return line => ({ ...line, needs: needsOf(line) });
}

/**
 * How much of the stream a watcher receives: `quiet` is the lines someone has to act on;
 * `notices` adds what happened to work that nobody has to act on; `protocol` is every
 * line, for a program that keeps an open set.
 */
export const attentionWatchLevelSchema = z.enum(['quiet', 'notices', 'protocol']);
export type AttentionWatchLevel = z.infer<typeof attentionWatchLevelSchema>;

/** True when a watcher at `level` receives `line`. `ready` and `bookmark` only sync a protocol reader. */
export function attentionWatchLevelPasses(
  level: AttentionWatchLevel,
  line: ClassifiedAttentionStreamLine
): boolean {
  if (level === 'protocol' || line.needs !== 'nothing') return true;
  return level === 'notices' && line.type !== 'ready' && line.type !== 'bookmark';
}
