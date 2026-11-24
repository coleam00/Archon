import type { ReactElement } from 'react';
import { HeaderBand, StatChip } from '../../factory/document';
import { durationWords } from '../../factory/lib/duration';
import {
  needsYouSubjectWords,
  needsYouSubjects,
  oldestWait,
  type NeedsYouItem,
} from '../../lib/needs-you';
import { SkeletonFigure } from '../Skeleton';

/** "2 items wait on you with no question to answer here.": no ask open; null for none. */
function awaitingWords(awaiting: number): string | null {
  if (awaiting === 0) return null;
  return awaiting === 1
    ? '1 item waits on you with no question to answer here.'
    : `${awaiting.toString()} items wait on you with no question to answer here.`;
}

/**
 * Needs you's header band (owner change 9): how many things wait, on what, and its key facts:
 * waiting now (in the needs-you colour while anything waits), how long the oldest has waited,
 * and how many were answered today. `count` is `needsYouCount`, the badge's count: the asks and
 * waits, and the `awaiting` items waiting on you with no ask open.
 */
export function NeedsYouHeader({
  count,
  awaiting,
  live,
  answeredToday,
  now,
}: {
  count: number;
  /** How many factory items wait on you with no ask open (`awaitingItems`). */
  awaiting: number;
  /** The open asks and waits, `needsYou` of the queue. */
  live: readonly NeedsYouItem[];
  /** Undefined while the history is unread; null when its read failed. */
  answeredToday: number | null | undefined;
  now: number;
}): ReactElement {
  const oldest = oldestWait(live);
  return (
    <HeaderBand
      className="lg:col-span-3"
      title={
        count === 0
          ? 'Nothing needs you'
          : count === 1
            ? '1 thing needs you'
            : `${count.toString()} things need you`
      }
      sentence={
        count === 0
          ? 'Questions your runs and items ask, runs paused for your decision, and items waiting on you appear here.'
          : [
              live.length === 0
                ? null
                : `Questions and paused waits ${needsYouSubjectWords(needsYouSubjects(live))}, answerable here.`,
              awaitingWords(awaiting),
            ]
              .filter(Boolean)
              .join(' ')
      }
      chips={
        <>
          <StatChip
            figure={count}
            label="waiting now"
            {...(count > 0 ? { state: 'needs-you' as const } : {})}
          />
          {oldest === undefined ? null : (
            <StatChip figure={durationWords(now - Date.parse(oldest))} label="oldest wait" />
          )}
          <StatChip
            figure={
              answeredToday === undefined ? (
                <SkeletonFigure />
              ) : answeredToday === null ? (
                '?'
              ) : (
                answeredToday
              )
            }
            label="answered today"
          />
        </>
      }
    />
  );
}
