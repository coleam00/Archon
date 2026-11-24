import { Hourglass, MessageCircleQuestion, type LucideIcon } from 'lucide-react';
import { displayItemKey } from '../../factory/lib/item-key';
import type { ReactElement } from 'react';
import { Panel } from '../../factory/document';
import type { AskNaming } from '../../lib/ask-naming';
import { relativeTime } from '../../lib/format';
import type { NeedsYouItem } from '../../lib/needs-you';
import type { AttentionQueue } from '../../skills/runs';
import { AskCard, SubjectName, type AskSubject } from '../ask-card/AskCard';
import { Ping } from '../ask-card/Ping';
import type { AnsweredHold } from '../ask-card/useAnsweredHold';

interface ItemAskPanelProps {
  projectId: string;
  subject: AskSubject;
  asks: readonly NeedsYouItem[];
  queue: Pick<AttentionQueue, 'runs'>;
  naming: AskNaming;
  hold: AnsweredHold;
  /** `open`: asks, with the ping; `paused`: waits past their deadline, the bar alone. */
  kind: 'open' | 'paused';
}

/**
 * One item's asks on Needs you (owner change 9): a filled panel with the needs-you colour as
 * its 3 px left bar, the item's number and title as its heading row (with the ping while it
 * asks), then each ask under the stage that asked, as the ask card draws it inside a panel.
 * The ping is open asks' alone (rule 5: only needs-you has the ping), so an open ask stays
 * the loudest thing on the page.
 */
export function ItemAskPanel({
  projectId,
  subject,
  asks,
  queue,
  naming,
  hold,
  kind,
}: ItemAskPanelProps): ReactElement {
  return (
    <Panel
      as="article"
      tone="var(--warning)"
      bar="left"
      aria-label={`Asks on ${displayItemKey(subject.key, subject.partOf)}`}
      className="flex flex-col gap-4 p-5 pl-6"
    >
      <div className="flex min-w-0 items-center gap-3">
        {kind === 'open' ? <Ping /> : null}
        <h3 className="flex min-w-0 text-console-15 font-semibold text-text-primary">
          <SubjectName subject={subject} />
        </h3>
      </div>
      {asks.map((ask, index) => {
        const answered = hold.answered.get(ask.ref);
        return (
          <div
            key={ask.ref}
            className={`flex min-w-0 flex-col gap-2 ${index === 0 ? '' : 'border-t border-border pt-4'}`}
          >
            <AskEyebrow
              ask={ask}
              naming={naming}
              fallback={kind === 'open' ? MessageCircleQuestion : Hourglass}
            />
            <AskCard
              embedded
              projectId={projectId}
              ask={ask}
              queue={queue}
              starts={id => naming.starts(ask, id)}
              {...(answered === undefined ? {} : { answered })}
              folding={hold.folding.has(ask.ref)}
              onAnswered={hold.onAnswered}
            />
          </div>
        );
      })}
    </Panel>
  );
}

/**
 * The stage that asked, as an eyebrow in its group's colour and icon (owner change 5: a group
 * colour may colour a document page's eyebrow), and how long ago; tertiary when no stage of a
 * factory view names the workflow.
 */
function AskEyebrow({
  ask,
  naming,
  fallback,
}: {
  ask: NeedsYouItem;
  naming: AskNaming;
  fallback: LucideIcon;
}): ReactElement | null {
  const where = naming.where(ask);
  if (where === undefined && ask.pausedAt === null) return null;
  const tone = naming.tone(ask);
  const Icon = tone?.Icon ?? fallback;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {where === undefined ? null : (
        <span
          data-ask-stage=""
          style={{ color: tone?.color ?? 'var(--text-tertiary)' }}
          className="flex min-w-0 items-center gap-2 text-console-12 font-medium uppercase tracking-console-label"
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {where}
        </span>
      )}
      {ask.pausedAt === null ? null : (
        <span className="ml-auto text-console-13 text-text-tertiary">
          {relativeTime(ask.pausedAt)}
        </span>
      )}
    </div>
  );
}
