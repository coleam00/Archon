import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { AskCard } from '../components/ask-card/AskCard';
import { askNaming, itemNames } from '../lib/ask-naming';
import { errorDetail } from '../lib/http';
import { awaitingItems, needsYou, needsYouPath } from '../lib/needs-you';
import { useProjectAttention } from '../components/ProjectAttention';
import { readFailed } from './lib/deadline';
import type { FactoryViewListed } from './lib/views';
import { FactoryLoading } from './FactoryLoading';
import { SkeletonBlock, SkeletonGroup } from '../components/Skeleton';
import { useFactoryItems } from './useFactoryItems';

/** How many asks the Overview shows before "N more" leads to the Needs you tab. */
const OVERVIEW_ASKS_SHOWN = 3;

/**
 * The Overview's Needs you: the newest asks as compact cards (the question and the
 * recommended tile), each opening on the Needs you tab, where it is answered; then how many
 * more wait there, the items waiting on you with no ask open (`awaitingItems`) among them, so
 * the line and the Need you number agree. Nothing shows when nothing waits.
 */
export function OverviewAsks({
  projectId,
  view,
}: {
  projectId: string;
  view: FactoryViewListed;
}): ReactNode {
  const attention = useProjectAttention();
  // The items the Overview's numbers and map read already: the cards name each item's title.
  const items = useFactoryItems(projectId);
  const queue = attention.data;
  if (queue === undefined) {
    const failed = readFailed(attention.error);
    if (failed !== undefined)
      return (
        <p role="alert" className="text-console-14 text-error">
          What needs you could not be loaded: {errorDetail(failed)}
        </p>
      );
    return (
      <FactoryLoading read={attention}>
        <SkeletonGroup label="Loading what needs you" className="flex max-w-3xl flex-col gap-3">
          {[0, 1, 2].map(index => (
            <SkeletonBlock key={index} height="h-24" rounded="rounded-console-16" />
          ))}
        </SkeletonGroup>
      </FactoryLoading>
    );
  }
  const asks = needsYou(queue.items);
  const awaiting = awaitingItems(items.data ?? []).length;
  if (asks.length === 0 && awaiting === 0) return null;
  const naming = askNaming(projectId, view, itemNames(items.data));
  const more = Math.max(0, asks.length - OVERVIEW_ASKS_SHOWN) + awaiting;
  return (
    <section aria-label="Needs you" className="flex flex-col gap-3">
      <h3 className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        Needs you
      </h3>
      {asks.slice(0, OVERVIEW_ASKS_SHOWN).map(ask => {
        const where = naming.where(ask);
        return (
          <AskCard
            key={ask.ref}
            projectId={projectId}
            ask={ask}
            queue={queue}
            subject={naming.subject(ask)}
            {...(where === undefined ? {} : { where })}
            variant="compact"
            openHref={needsYouPath(projectId, ask.ref)}
          />
        );
      })}
      {more > 0 ? <MoreLink projectId={projectId} more={more} shown={asks.length > 0} /> : null}
    </section>
  );
}

/**
 * The line to the Needs you tab: "N more on Needs you" under the asks shown, or, with none to
 * show (only items waiting on you with no ask open), how many items wait there.
 */
function MoreLink({
  projectId,
  more,
  shown,
}: {
  projectId: string;
  more: number;
  shown: boolean;
}): ReactElement {
  return (
    <Link
      to={needsYouPath(projectId)}
      className="self-start text-console-13 text-text-secondary hover:text-text-primary hover:underline"
    >
      {shown
        ? `${more.toString()} more on Needs you`
        : `${more.toString()} ${more === 1 ? 'item waits' : 'items wait'} for you on Needs you`}
    </Link>
  );
}
