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
 * How much of the stream a watcher receives: `quiet` is the lines someone has to act on
 * and the close of an item it was shown; `notices` adds what happened to work that nobody
 * has to act on; `protocol` is every line, for a program that keeps an open set.
 */
export const attentionWatchLevelSchema = z.enum(['quiet', 'notices', 'protocol']);
export type AttentionWatchLevel = z.infer<typeof attentionWatchLevelSchema>;

/**
 * The one rule for a watcher at `level`: what each stream line asks of its reader, and
 * whether the watcher receives it. A fresh reader per stream returns each line it shows
 * with its `needs`, and undefined for a line it does not show.
 *
 * `needs` says only what someone must do:
 * - `answer`: an item that takes an answer.
 * - `look`: an item nothing can describe; a usage-limit wait that replaces an item that
 *   needed someone; a run that failed, completed with a failed outcome, or lost its owner;
 *   and a stream that lost coverage or ended.
 * - `nothing`: everything else, including the close of an item (`resolved`, `unmatched`),
 *   which leaves nothing to do.
 *
 * The level decides what is shown. Every level shows the `answer` and `look` lines and
 * the close of an item that needed someone, so nobody keeps working on an ask that was
 * answered or moved. `notices` adds the other `nothing` lines about work; `ready` and
 * `bookmark` only sync a `protocol` reader.
 *
 * `resumed` is for a stream that continues an earlier one from a cursor. The reader did
 * not see which items that earlier stream showed, so it shows every close: telling a
 * reader that an item it never held has closed is harmless, and dropping the close of
 * one it holds leaves it working on an ask that is gone.
 */
export function attentionWatchReader(
  level: AttentionWatchLevel,
  options: { resumed?: boolean } = {}
): (line: AttentionStreamLine) => ClassifiedAttentionStreamLine | undefined {
  const shown = new Set<string>();
  /** What `line` asks, and whether it closes an item this watcher was shown. */
  const read = (line: AttentionStreamLine): { needs: AttentionNeeds; closesShown?: boolean } => {
    switch (line.type) {
      case 'attention':
        switch (line.item.kind) {
          case 'attention':
          case 'awaiting_response':
            shown.add(line.item.runId);
            return { needs: 'answer' };
          case 'unreadable':
            shown.add(line.item.runId);
            return { needs: 'look' };
          case 'usage_limit':
            return { needs: shown.delete(line.item.runId) ? 'look' : 'nothing' };
        }
        return line.item satisfies never;
      case 'resolved':
      case 'unmatched':
        return {
          needs: 'nothing',
          closesShown: shown.delete(line.runId) || options.resumed === true,
        };
      case 'terminal':
        // A run that ran to the end and judged its work unsuccessful needs a look too.
        return {
          needs: line.status === 'failed' || line.outcome === 'failed' ? 'look' : 'nothing',
        };
      case 'owner_lost':
      case 'degraded':
      case 'error':
        return { needs: 'look' };
      case 'resumed':
      case 'ready':
      case 'bookmark':
        return { needs: 'nothing' };
    }
    return line satisfies never;
  };
  return line => {
    const { needs, closesShown } = read(line);
    const passes =
      level === 'protocol' ||
      needs !== 'nothing' ||
      closesShown === true ||
      (level === 'notices' && line.type !== 'ready' && line.type !== 'bookmark');
    return passes ? { ...line, needs } : undefined;
  };
}
