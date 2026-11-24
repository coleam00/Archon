import type { ReactElement } from 'react';
import { displayItemKey } from '../../factory/lib/item-key';
import type { AskStarts } from '../../lib/ask-naming';
import type { NeedsYouItem } from '../../lib/needs-you';
import type { AttentionQueue } from '../../skills/runs';
import { AskCard, SubjectName, type AskSubject } from './AskCard';
import { useAnsweredHold, type AnsweredHold } from './useAnsweredHold';

/**
 * One item's asks: the item named once, then a card per ask. It takes the asks and the
 * queue's runs and needs no page around it, so the item page (which leaves out `subject`:
 * the page is the item) and a popover over a board card both draw it; the Needs you tab
 * draws its own panels (`ItemAskPanel`). A caller that holds answers itself passes its
 * `hold`, so the asks it shows keep their answers while they show; alone, the group holds its
 * own.
 */
export function AskGroup({
  projectId,
  subject,
  asks,
  queue,
  where,
  starts,
  hold: outer,
}: {
  projectId: string;
  subject?: AskSubject;
  asks: readonly NeedsYouItem[];
  queue: Pick<AttentionQueue, 'runs'>;
  /** The stage or workflow each ask came from. */
  where?: (ask: NeedsYouItem) => string | undefined;
  /** What choosing an option of each ask starts, in the factory view's words. */
  starts?: AskStarts;
  hold?: AnsweredHold;
}): ReactElement {
  const own = useAnsweredHold(asks);
  const hold = outer ?? own;
  const shown = outer === undefined ? own.asks : asks;
  return (
    <section
      aria-label={
        subject === undefined ? 'Asks' : `Asks on ${displayItemKey(subject.key, subject.partOf)}`
      }
      className="flex flex-col gap-3"
    >
      {subject === undefined ? null : (
        <h2 className="flex min-w-0 text-console-15 font-semibold">
          <SubjectName subject={subject} />
        </h2>
      )}
      {shown.map(ask => {
        const answered = hold.answered.get(ask.ref);
        const at = where?.(ask);
        return (
          <AskCard
            key={ask.ref}
            projectId={projectId}
            ask={ask}
            queue={queue}
            {...(at === undefined ? {} : { where: at })}
            {...(starts === undefined ? {} : { starts: (id: string) => starts(ask, id) })}
            {...(answered === undefined ? {} : { answered })}
            folding={hold.folding.has(ask.ref)}
            onAnswered={hold.onAnswered}
          />
        );
      })}
    </section>
  );
}
