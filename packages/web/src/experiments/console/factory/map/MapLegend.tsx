import type { ReactElement } from 'react';
import { BACK, BACK_DASH, BACK_OPACITY, LINE_TO, MAIN_STROKE, STROKE } from '../canvas-lines';
import type { ColumnTone } from '../lib/map-columns';
import { TONES } from '../tones';

const ITEM = 'flex items-center gap-1.5 text-console-12 text-text-secondary';

/**
 * The colour groups the map's cards are in, named in plain words in the order work reaches
 * them, and what each kind of line means, each drawn as the map draws it. `map` says which
 * map it sits under: the curated map shows a card's send-backs on demand and moves its dots;
 * the Full workflow draws every send-back and moves nothing, so it names neither.
 */
export function MapLegend({
  tones,
  map,
}: {
  tones: readonly ColumnTone[];
  map: 'curated' | 'full';
}): ReactElement {
  const shown = [...new Set(tones)];
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label="Colour groups" className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {shown.map(tone => (
          <li key={tone} className={ITEM}>
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-sm"
              style={{ background: TONES[tone].color }}
            />
            {TONES[tone].words}
          </li>
        ))}
      </ul>
      <ul aria-label="Lines" className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <li className={ITEM}>
          <svg aria-hidden="true" width="22" height="8" className="shrink-0">
            <line x1="1" y1="4" x2="21" y2="4" stroke={LINE_TO} strokeWidth={MAIN_STROKE} />
          </svg>
          Hands the item on
        </li>
        <li className={ITEM}>
          <svg aria-hidden="true" width="22" height="8" className="shrink-0">
            <line
              data-legend="send-back"
              x1="1"
              y1="4"
              x2="21"
              y2="4"
              stroke={BACK}
              strokeWidth={STROKE}
              strokeDasharray={BACK_DASH}
              strokeOpacity={BACK_OPACITY}
            />
          </svg>
          {map === 'curated'
            ? 'Sends it back to an earlier group, its pill saying where and why'
            : 'Sends it back, labelled where it returns to'}
        </li>
        {map === 'curated' ? <FlowDots /> : null}
      </ul>
    </div>
  );
}

/** The curated map's dots. No dot moves under reduced motion, so the legend does not say one does. */
function FlowDots(): ReactElement {
  return (
    <>
      <li className={`${ITEM} motion-reduce:hidden`}>
        <span
          aria-hidden="true"
          className="inline-block size-1.5 rounded-full"
          style={{ background: LINE_TO }}
        />
        A faint dot follows the flow from the first card to the last
      </li>
      <li className={`${ITEM} motion-reduce:hidden`}>
        <span
          aria-hidden="true"
          className="map-flow-swatch inline-block size-2.5 rounded-full bg-[color:var(--running)]"
        />
        A bright dot runs into a card while a run works an item there
      </li>
    </>
  );
}
