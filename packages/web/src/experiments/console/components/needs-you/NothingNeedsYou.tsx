import { CheckCircle2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Panel } from '../../factory/document';
import { relativeTime } from '../../lib/format';
import { SkeletonInnerLine } from '../Skeleton';

const LINK = 'text-console-13 text-text-secondary hover:text-text-primary hover:underline';

/**
 * Needs you with nothing open (owner change 9, rule 6 on a panel): a check in a soft success
 * tint, "Nothing needs you", when something was last asked (a skeleton bar while the history
 * is unread; nothing when its read failed, never the never-asked sentence), and the board and
 * the runs. The board link
 * needs a factory view; `boardHref` is undefined without one.
 */
export function NothingNeedsYou({
  projectId,
  lastAsked,
  loading,
  boardHref,
  className = '',
}: {
  projectId: string;
  /** When something was last asked; null when nothing ever was; undefined while unknown. */
  lastAsked: string | null | undefined;
  /** The history is still being read: a skeleton bar where "Last asked" goes. */
  loading: boolean;
  boardHref: string | undefined;
  className?: string;
}): ReactElement {
  return (
    <Panel
      as="section"
      aria-label="Nothing needs you"
      className={`flex flex-col items-start gap-3 p-6 ${className}`}
    >
      <span
        data-empty-icon=""
        className="flex size-10 items-center justify-center rounded-full bg-[color:var(--success-soft)]"
      >
        <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-console-17 font-semibold text-text-primary">Nothing needs you</h2>
        {loading ? (
          // An inner line: on the panel's fill a plain skeleton bar would not show.
          <span aria-hidden="true" data-skeleton="line" className="motion-safe:animate-pulse">
            <SkeletonInnerLine width="short" />
          </span>
        ) : null}
        {lastAsked === undefined ? null : (
          <p className="text-console-14 text-text-secondary">
            {lastAsked === null
              ? 'A question a run asks, or a run paused for your decision, appears here to answer.'
              : `Last asked ${relativeTime(lastAsked)}.`}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {boardHref === undefined ? null : (
          <Link to={boardHref} className={LINK}>
            Open the board
          </Link>
        )}
        <Link to={`/console/p/${projectId}`} className={LINK}>
          See the runs
        </Link>
      </div>
    </Panel>
  );
}
