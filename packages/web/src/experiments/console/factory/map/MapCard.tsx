import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import type { PlacedCard } from '../lib/map-layout';
import type { StageRead } from '../lib/map-live';
import type { FactoryStage } from '../lib/stage-steps';
import type { StageModalLink } from '../lib/views';
import { cardTone, TONES } from '../tones';
import { chipWords, HereChip, NeedsYouChip } from './MapChips';
import { MapShadowBadge, MapStageRow } from './MapStageRow';

interface MapCardProps {
  card: PlacedCard;
  /** Its stages, in the card's order. */
  stages: readonly FactoryStage[];
  /**
   * A stage's chips. Before the items are read a chip is a skeleton bar, and there is none
   * once the first read failed.
   */
  live: (stage: string) => StageRead;
  selected: boolean;
  /** The link a click on a stage's card or row follows: the stage, open over the map. */
  stageLink: (stage: string) => StageModalLink;
  /** The details button: the map shows or hides this card's details panel. */
  onDetails: (card: string) => void;
  /**
   * A stage's shadow steps, each with what it decided lately (`stageShadowLines`): its name
   * carries the badge, which says them on hover. Empty when it holds none.
   */
  shadows: (stage: FactoryStage) => readonly string[];
}

/**
 * The box every card shares (Visual standard, rule 2); `link` makes the whole of it one. Its
 * fill, depth, light, border colour and hover are `.factory-card`'s (theme.css).
 */
const BOX =
  'factory-card relative flex size-full flex-col gap-2 overflow-hidden rounded-console-12 border px-3 pb-3 pt-4';

/**
 * Whether the card is lit: one of its stages holds an item. Not the merged card, which holds
 * every merged item for good, so its light would say nothing.
 */
function lit(
  card: PlacedCard,
  stages: readonly FactoryStage[],
  live: MapCardProps['live']
): boolean {
  if (card.tone === 'merged') return false;
  return stages.some(stage => {
    const read = live(stage.id);
    return typeof read !== 'string' && read.items.length > 0;
  });
}

/**
 * One card on the map: a board column, in the card language. A card of one stage is that
 * stage (its label, its short line, its chips) and opens it; a card of several lists them as
 * rows, each opening its own stage, under the column's label.
 */
export function MapCard({
  card,
  stages,
  live,
  selected,
  stageLink,
  onDetails,
  shadows,
}: MapCardProps): ReactElement {
  const [only] = stages;
  const box = {
    className: BOX,
    style: cardTone(TONES[card.tone].color),
    'data-lit': lit(card, stages, live) ? '' : undefined,
    'data-selected': selected ? '' : undefined,
  };
  const body = (children: ReactNode): ReactNode => (
    <>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ background: TONES[card.tone].color }}
      />
      <KindRow card={card} />
      {children}
    </>
  );
  return (
    <div
      data-card={card.id}
      className="absolute"
      style={{ left: card.box.x, top: card.box.y, width: card.box.w, height: card.box.h }}
    >
      {stages.length === 1 && only !== undefined ? (
        <Link
          to={stageLink(only.id).to}
          state={stageLink(only.id).state}
          data-stage={only.id}
          aria-label={`${only.label}: ${chipWords(live(only.id))}`}
          // A link is natively draggable: a pan that starts on the card would become a link
          // drag the map never sees.
          draggable={false}
          {...box}
        >
          {body(<OneStage stage={only} live={live(only.id)} shadows={shadows(only)} />)}
        </Link>
      ) : (
        <div {...box}>
          {body(
            <>
              <span
                title={card.label}
                className="truncate text-console-15 font-semibold leading-5 text-text-primary"
              >
                {card.label}
              </span>
              {stages.map(stage => (
                <MapStageRow
                  key={stage.id}
                  stage={stage}
                  live={live(stage.id)}
                  openTo={stageLink(stage.id)}
                  shadows={shadows(stage)}
                />
              ))}
            </>
          )}
        </div>
      )}
      {/* Beside the card's links, not in them: a button inside a link is invalid. */}
      <button
        type="button"
        aria-label={`${card.label} details`}
        aria-pressed={selected}
        title="Details"
        // A press on the button must not start a pan of the map under it.
        onPointerDown={event => event.stopPropagation()}
        onClick={() => onDetails(card.id)}
        className="absolute right-2 top-3 rounded px-1 text-console-13 leading-4 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
      >
        ⓘ
      </button>
    </div>
  );
}

/** Row 1: the group's icon and kind label (rule 2). */
function KindRow({ card }: { card: PlacedCard }): ReactElement {
  const { Icon, kind, color } = TONES[card.tone];
  return (
    <span className="flex h-4 items-center gap-1.5 pr-6">
      <Icon aria-hidden="true" className="size-4 shrink-0" style={{ color }} />
      <span className="truncate text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        {kind}
      </span>
    </span>
  );
}

/**
 * A card of one stage: its label (with the shadow badge when it holds a shadow step), its
 * short line (or its blurb, two lines), its chips.
 */
function OneStage({
  stage,
  live,
  shadows,
}: {
  stage: FactoryStage;
  live: StageRead;
  shadows: readonly string[];
}): ReactElement {
  return (
    <>
      <span className="flex items-start gap-2">
        <span className="line-clamp-2 min-w-0 text-console-15 font-semibold leading-5 text-text-primary">
          {stage.label}
        </span>
        <MapShadowBadge lines={shadows} />
      </span>
      <span className="line-clamp-2 text-console-13 leading-4.5 text-text-secondary">
        {stage.short ?? stage.blurb}
      </span>
      <span className="mt-auto flex gap-1 overflow-hidden">
        <HereChip live={live} />
        <NeedsYouChip live={live} />
      </span>
    </>
  );
}
