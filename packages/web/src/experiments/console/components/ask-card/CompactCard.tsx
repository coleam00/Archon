import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';
import { askTile } from '../../lib/ask-card';
import type { NeedsYouItem } from '../../lib/needs-you';
import { markProps, RECOMMENDED_BG, RecommendedBadge } from './tile-marks';

// console-token-exception max-w-[760px] -- Visual standard rule 9: an ask card is at most 760 px wide in a page.
const WIDTH = 'max-w-[760px]';
// Beside the question (520 px and up) a long unbroken label would take the whole row and
// squeeze the question to nothing; it wraps within this share instead.
const TILE_SHARE = '@min-[520px]:max-w-[45%]';

/**
 * The ask card's compact variant (the Overview): one line of what it is about, then the
 * question on one line beside the recommended tile, drawn as a tile but not a control (so
 * green, never selected), and Open, which answers it on the Needs you tab. Long unbroken
 * words wrap rather than widen the card. Nothing here sends an answer. Three of these
 * leave the top of the map in a 1440x900 first screen (Visual standard, Layout).
 */
export function CompactCard({
  ask,
  question,
  header,
  openHref,
}: {
  ask: NeedsYouItem;
  question: string;
  header: ReactNode;
  openHref: string | undefined;
}): ReactElement {
  const tile = askTile(ask);
  return (
    <article
      aria-label={question}
      data-ask={ask.ref}
      className={`@container flex w-full min-w-0 ${WIDTH} flex-col gap-2 rounded-console-16 border border-border bg-surface p-4`}
    >
      {header}
      <div className="flex flex-col gap-2 @min-[520px]:flex-row @min-[520px]:items-center @min-[520px]:gap-3">
        <h3
          title={question}
          className="line-clamp-2 min-w-0 flex-1 text-console-15 font-semibold text-text-primary [overflow-wrap:anywhere] @min-[520px]:line-clamp-1"
        >
          {question}
        </h3>
        <div
          title={tile.detail}
          className={`flex min-w-0 max-w-full ${TILE_SHARE} items-baseline gap-2 self-start rounded-console-12 border px-3 py-1.5 @min-[520px]:self-auto ${
            tile.recommended ? RECOMMENDED_BG : 'border-border bg-surface'
          }`}
          {...markProps(false, tile.recommended)}
        >
          <span className="line-clamp-2 min-w-0 text-console-14 font-semibold text-text-primary [overflow-wrap:anywhere]">
            {tile.label}
          </span>
          {tile.recommended ? <RecommendedBadge /> : null}
        </div>
        {openHref === undefined ? null : (
          <Link
            to={openHref}
            className="self-start rounded-console-12 border border-border px-3 py-1.5 text-console-13 font-medium text-text-primary transition-colors duration-150 ease-out hover:border-border-bright hover:bg-surface-elevated @min-[520px]:self-auto"
          >
            Open
          </Link>
        )}
      </div>
    </article>
  );
}
