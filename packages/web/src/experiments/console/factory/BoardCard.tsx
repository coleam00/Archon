import type { ReactElement, ReactNode } from 'react';
import { displayItemKey } from './lib/item-key';
import { Link, useSearchParams } from 'react-router';
import { statusDotClass, statusTextClass } from '../lib/run-status';
import {
  itemPath,
  PILL_LABEL,
  type BoardCard as BoardCardFields,
  type Pill,
  type RoundVerdict,
} from './lib/board';
import { engineIdTitle } from './lib/step-label';
import { orderSearch } from './lib/work-orders';
import { CardAsk, shownAsk } from './BoardAskFace';
import { ShadowBadge } from './ShadowBadge';
import type { BoardAsks } from './useBoardAsks';

/**
 * State colours (Visual standard, rule 5): each state's colour as text on its soft
 * background, with Needs you the one filled, loud pill. The board's card and table and the
 * item page's header all draw the pill from here.
 */
export const PILL_CLASS: Record<Pill, string> = {
  running: 'bg-[color:var(--running-soft)] text-[color:var(--running)]',
  'needs-you': 'bg-warning font-semibold text-surface-inset',
  failed: 'bg-[color:var(--error-soft)] text-error',
  // Waits on you with no ask: the needs-you colour, soft. Only an open ask's pill is filled.
  awaits: 'bg-[color:var(--warning-soft)] text-warning',
  parked: 'bg-surface-inset text-text-secondary ring-1 ring-inset ring-border',
  waiting: 'bg-surface-inset text-text-tertiary',
  landed: 'bg-[color:var(--success-soft)] text-success',
};

/** A round's verdict colour, as a dot on the card. */
const VERDICT_DOT_CLASS: Record<RoundVerdict, string> = {
  approved: 'bg-success',
  returned: 'bg-error',
  undecided: 'bg-warning',
  running: statusDotClass.running,
  stopped: 'bg-text-tertiary/60',
};

/** The state pill, in `label` when the item names its state (an `awaits` label), else `PILL_LABEL`. */
export function PillBadge({ pill, label }: { pill: Pill; label?: string }): ReactElement {
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-console-12 font-medium ${PILL_CLASS[pill]}`}
    >
      {label ?? PILL_LABEL[pill]}
    </span>
  );
}

export function RoundDots({
  round,
}: {
  round: NonNullable<BoardCardFields['round']>;
}): ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-console-12 text-text-secondary">
      {round.text}
      <span className="flex items-center gap-0.5">
        {round.dots.map(dot => (
          <span
            key={dot.iteration}
            role="img"
            aria-label={dot.label}
            title={dot.label}
            className={`inline-block h-1.5 w-1.5 rounded-full ${VERDICT_DOT_CLASS[dot.verdict]}`}
          />
        ))}
      </span>
    </span>
  );
}

/** A link inside the card, above the card-wide link to the item page. */
const INNER_LINK = 'relative z-10 hover:underline';

interface CardProps {
  projectId: string;
  card: BoardCardFields;
  /** The card just changed stage: a brief highlight shows it. */
  moved: boolean;
  /** Another work order is lit on the board (`?order=`) and this card is not in it. */
  dimmed?: boolean;
  /** Its column's colour, drawn as the bar on its top edge (Visual standard, rule 2). */
  accent: string;
}

/**
 * The card's box (Visual standard, rule 2): the item's key and pill, then its title, whose
 * link stretches over the card. The whole card opens the item page while the links inside
 * sit above that link, so no link nests in another.
 */
function CardBox({
  projectId,
  card,
  moved,
  dimmed = false,
  accent,
  short = false,
  children,
}: CardProps & {
  /** The card carries an ask's face: its title takes 2 lines, not 3, so the card stays short. */
  short?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <article
      data-card={card.key}
      data-moved={moved ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      className={`relative flex flex-col gap-2 overflow-hidden rounded-console-12 border p-3 motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:border-border-bright hover:bg-surface-elevated ${
        moved ? 'border-accent-bright bg-[color:var(--accent-soft)]' : 'border-border bg-surface'
      } ${dimmed ? 'opacity-40' : ''}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ background: accent }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-console-12 text-text-tertiary">
          {displayItemKey(card.key, card.order)}
        </span>
        <PillBadge pill={card.pill} label={card.pillLabel} />
      </div>
      <Link
        to={itemPath(projectId, card.key)}
        className={`${short ? 'line-clamp-2' : 'line-clamp-3'} text-console-15 font-semibold leading-snug text-text-primary after:absolute after:inset-0`}
      >
        {card.title}
      </Link>
      {children}
    </article>
  );
}

/**
 * One item on the board, its fields in DESIGN.md's order. Its stage line is what runs now,
 * else the stage it waits in, so a card names its stage inside a column that groups several.
 */
export function BoardCard(props: CardProps & { asks: BoardAsks }): ReactElement {
  const { card } = props;
  return (
    <CardBox {...props} short={shownAsk(card, props.asks) !== null}>
      {card.run !== null ? (
        <RunLink run={card.run} />
      ) : card.stage === null ? null : (
        <span title={card.stage} className="min-w-0 truncate text-console-13 text-text-secondary">
          {card.stage}
        </span>
      )}
      {card.shadow === null ? null : <ShadowLine shadow={card.shadow} />}
      {card.order === null ? null : <OrderChip order={card.order} />}
      {card.round === null ? null : <RoundDots round={card.round} />}
      <CardLinks card={card} />
      <CardAsk card={card} asks={props.asks} />
    </CardBox>
  );
}

/** A merged item, compact: its key, title, pull request and when it merged. */
export function MergedCard(props: CardProps): ReactElement {
  const { card } = props;
  return (
    <CardBox {...props}>
      <span className="flex flex-wrap items-center gap-x-2 text-console-13 text-text-tertiary">
        {card.change === null ? null : <ChangeLink change={card.change} />}
        {card.mergedAt === null ? null : <span>Merged {card.mergedAt}</span>}
      </span>
    </CardBox>
  );
}

/**
 * The running run's line: stage, step name, round, on one line (owner, 2026-11-19: the board
 * fits two cards per column); the step name is cut first, with the whole line in the title.
 */
function RunLink({ run }: { run: NonNullable<BoardCardFields['run']> }): ReactElement {
  return (
    <Link
      to={run.href}
      title={engineIdTitle(run.text, run.step)}
      aria-label={run.text}
      className={`${INNER_LINK} flex min-w-0 flex-nowrap gap-x-1 overflow-hidden text-console-13 ${statusTextClass.running}`}
    >
      {run.parts.map((part, index) => (
        <span
          key={index}
          className={index === 1 ? 'min-w-0 max-w-full truncate' : 'whitespace-nowrap'}
        >
          {part}
          {index < run.parts.length - 1 ? ' ·' : ''}
        </span>
      ))}
    </Link>
  );
}

/**
 * What a shadow step of the card's stage would have done (rule 10): the badge and its words,
 * tertiary, never a state colour; its why on hover.
 */
function ShadowLine({ shadow }: { shadow: NonNullable<BoardCardFields['shadow']> }): ReactElement {
  return (
    <span
      data-shadow-line="true"
      title={shadow.detail ?? undefined}
      className="flex min-w-0 items-baseline gap-1.5 text-console-13 text-text-tertiary"
    >
      <ShadowBadge />
      <span className={`truncate ${shadow.mono ? 'font-mono' : ''}`}>{shadow.line}</span>
    </span>
  );
}

/** "part of #48": lights the item's work order on the board, keeping the board's view. */
function OrderChip({ order }: { order: string }): ReactElement {
  const [params] = useSearchParams();
  return (
    <Link
      to={{ search: orderSearch(params, order) }}
      replace
      title={`Light work order ${displayItemKey(order, null)} on the board`}
      className={`${INNER_LINK} self-start rounded-full bg-surface-inset px-2 py-0.5 text-console-12 text-text-secondary`}
    >
      part of <span className="font-mono">{displayItemKey(order, null)}</span>
    </Link>
  );
}

const MERGE_STATE_WORDS = {
  unknown: {
    text: 'merge state unknown',
    title: 'The change host could not say whether this change merged',
  },
  pending: {
    text: 'checking merge state',
    title: 'The server is still asking the change host whether this change merged',
  },
} as const;

/**
 * Said where a change's merge state could not be read or is still being asked, so it never
 * reads as unmerged.
 */
export function MergeState({
  state,
}: {
  state: keyof typeof MERGE_STATE_WORDS | null;
}): ReactElement | null {
  if (state === null) return null;
  const words = MERGE_STATE_WORDS[state];
  return (
    <span className="text-text-tertiary" title={words.title}>
      {words.text}
    </span>
  );
}

/** The change: its pull request, linking out once its URL is known. */
function ChangeLink({ change }: { change: NonNullable<BoardCardFields['change']> }): ReactElement {
  if (change.href === null) return <span className="text-text-secondary">{change.label}</span>;
  return (
    <a
      href={change.href}
      target="_blank"
      rel="noreferrer"
      className={`${INNER_LINK} text-accent-bright`}
    >
      {change.label}
    </a>
  );
}

function CardLinks({ card }: { card: BoardCardFields }): ReactNode {
  if (card.returned === null && card.change === null) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-console-13">
      {card.returned === null ? null : (
        <Link to={card.returned.href} className={`${INNER_LINK} text-text-secondary`}>
          returned ×{card.returned.count}
        </Link>
      )}
      {card.change === null ? null : <ChangeLink change={card.change} />}
      <MergeState state={card.change?.mergeState ?? null} />
    </span>
  );
}
