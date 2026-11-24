import type { ReactElement, ReactNode } from 'react';
import { displayItemKey } from '../../factory/lib/item-key';
import { Link } from 'react-router';
import { ClampedSummary } from '../../factory/ClampedSummary';
import { askQuestion } from '../../lib/ask-card';
import { parseOffered, type Offered } from '../../lib/ask-offered';
import { unrecommendedOf } from '../../lib/ask-unrecommended';
import { relativeTime } from '../../lib/format';
import type { NeedsYouItem } from '../../lib/needs-you';
import type { AttentionQueue } from '../../skills/runs';
import { AskBody } from './AskBody';
import { CompactCard } from './CompactCard';
import { OfferedBlock } from './OfferedBlock';

/** The item (or run) an ask is about, as its card's header names and links it. */
export interface AskSubject {
  key: string;
  /** The work order the item is a member of, which its key reads under; null for a run or an item in none. */
  partOf: string | null;
  title?: string;
  /** The factory item page when the project has a factory view, else the run; none when neither is known. */
  href?: string;
}

export interface AskCardProps {
  projectId: string;
  ask: NeedsYouItem;
  /** The queue's runs, which a paused gate is answered through. */
  queue: Pick<AttentionQueue, 'runs'>;
  /** Named in the header; left out where a group or the page already names the item. */
  subject?: AskSubject;
  /** The stage the ask came from when a factory view names it, else its workflow. */
  where?: string;
  /** What choosing an option starts, in the factory view's words (`answers`); none without a view. */
  starts?: (optionId: string) => string | undefined;
  /** `compact` (the Overview): the question, the recommended tile, and Open. */
  variant?: 'full' | 'compact';
  /** Where Open leads, for the compact card. */
  openHref?: string;
  /** Set once answered: the words it was answered with, shown in place. */
  answered?: string;
  folding?: boolean;
  onAnswered?: (ask: NeedsYouItem, label: string) => void;
  /**
   * Drawn inside a panel that already names the item and the stage (the Needs you tab, owner
   * change 9): no box of its own and no header row, so a box never sits inside a box.
   */
  embedded?: boolean;
}

// console-token-exception max-w-[760px] -- Visual standard rule 9: an ask card is at most 760 px wide in a page.
const WIDTH = 'max-w-[760px]';
const FLOW = '@container flex w-full min-w-0 flex-col gap-3';
const BOX = `${FLOW} ${WIDTH} rounded-console-16 border border-border bg-surface p-5`;
const FOLD = 'motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out';

/**
 * The ask card (DESIGN.md, Visual standard rule 9): the one design wherever an ask or a
 * paused wait is answered. It takes one ask and the queue's runs and needs no page around
 * it, so the Needs you tab, the Overview, the item page and a popover all draw it.
 */
export function AskCard(props: AskCardProps): ReactElement {
  const { ask, answered, folding = false, variant = 'full', embedded = false } = props;
  if (variant === 'compact')
    return (
      <CompactCard
        ask={ask}
        question={askQuestion(ask)}
        header={<AskHeader {...props} />}
        openHref={props.openHref}
      />
    );
  const unrecommended = unrecommendedOf(ask);
  // An ask without a recommendation says why under its tiles, so its context loses that paragraph.
  const context =
    ask.kind !== 'attention'
      ? undefined
      : unrecommended === null
        ? ask.context
        : unrecommended.context;
  const offered = offeredOf(ask, context);
  return (
    <article
      aria-label={askQuestion(ask)}
      data-ask={ask.ref}
      tabIndex={-1}
      className={`${embedded ? FLOW : BOX} ${FOLD} ${folding ? 'opacity-0' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      {embedded ? null : <AskHeader {...props} />}
      <h3 className="line-clamp-2 text-console-17 font-semibold text-text-primary [overflow-wrap:anywhere]">
        {askQuestion(ask)}
      </h3>
      {answered !== undefined ? (
        <p
          role="status"
          className="text-console-14 font-medium text-success [overflow-wrap:anywhere]"
        >
          Answered: {answered}
        </p>
      ) : (
        <>
          <AskContext context={context} offered={offered} />
          <AskBody
            {...props}
            offered={offered}
            {...(unrecommended === null ? {} : { unrecommended: unrecommended.line })}
          />
        </>
      )}
    </article>
  );
}

/** Meta row: the item key (and title) on the left; the stage or workflow and the age on the right. */
function AskHeader({ subject, where, ask }: AskCardProps): ReactNode {
  if (subject === undefined && where === undefined && ask.pausedAt === null) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-console-13 text-text-tertiary">
      {subject === undefined ? null : <SubjectName subject={subject} />}
      <span className="ml-auto flex min-w-0 items-baseline gap-2">
        {where === undefined ? null : <span>{where}</span>}
        {ask.pausedAt === null ? null : <span>{relativeTime(ask.pausedAt)}</span>}
      </span>
    </div>
  );
}

export function SubjectName({ subject }: { subject: AskSubject }): ReactElement {
  const words = (
    <>
      {/* The key is how a person names the item: it never shrinks or wraps; the title truncates. */}
      <span className="shrink-0 whitespace-nowrap font-mono">
        {displayItemKey(subject.key, subject.partOf)}
      </span>
      {subject.title === undefined ? null : (
        <span className="min-w-0 truncate text-text-secondary"> {subject.title}</span>
      )}
    </>
  );
  return subject.href === undefined ? (
    <span className="flex min-w-0 items-baseline gap-1">{words}</span>
  ) : (
    <Link
      to={subject.href}
      className="flex min-w-0 items-baseline gap-1 text-text-secondary hover:text-text-primary hover:underline"
    >
      {words}
    </Link>
  );
}

/** What the stage offered, when an ask's context carries the pack's list of it. */
function offeredOf(ask: NeedsYouItem, context: string | undefined): Offered | null {
  if (ask.kind !== 'attention' || context === undefined) return null;
  return parseOffered(context, ask.recommendation?.why);
}

/**
 * The ask's context, clamped to three lines with More; what happened, for a run it cannot
 * answer. When the context carries what the stage offered, the rest of it keeps the clamp and
 * the offered list shows whole under it (`OfferedBlock`).
 */
function AskContext({
  context,
  offered,
}: {
  /** An attention ask's context, as the card shows it; undefined for any other ask. */
  context: string | undefined;
  offered: Offered | null;
}): ReactNode {
  if (context === undefined) return null;
  if (offered === null) return <ClampedSummary key={context} text={context} lines={3} />;
  return (
    <>
      {offered.rest === '' ? null : (
        <ClampedSummary key={offered.rest} text={offered.rest} lines={3} />
      )}
      <OfferedBlock offered={offered} />
    </>
  );
}
