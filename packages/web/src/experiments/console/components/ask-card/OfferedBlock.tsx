import type { ReactElement } from 'react';
import { humaniseId } from '../../lib/ask-card';
import type { Offered, OfferedOption } from '../../lib/ask-offered';
import { markProps, RECOMMENDED_BG, RecommendedBadge } from './tile-marks';

const WORDS = 'text-console-13 text-text-secondary [overflow-wrap:anywhere]';

/**
 * What the stage offered in its own words (DESIGN.md, Visual standard rule 9), between the
 * context and the tiles and never clamped: the decision the stage is asking for, which the
 * tiles' routes do not name. Rows are plain list items, not buttons, so nothing here looks
 * pickable; the one the stage recommends wears the tiles' green mark.
 */
export function OfferedBlock({ offered }: { offered: Offered }): ReactElement {
  return (
    <section aria-label="What the stage offered" className="flex min-w-0 flex-col gap-2">
      <h4 className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        What the stage offered
      </h4>
      <ul className="flex min-w-0 flex-col gap-2">
        {offered.options.map(option => (
          <OfferedRow
            key={option.id}
            option={option}
            recommended={option.id === offered.recommended}
          />
        ))}
      </ul>
    </section>
  );
}

function OfferedRow({
  option,
  recommended,
}: {
  option: OfferedOption;
  recommended: boolean;
}): ReactElement {
  return (
    <li
      className={`flex min-w-0 flex-col items-start gap-1 rounded-console-12 border px-3 py-2 ${recommended ? RECOMMENDED_BG : 'border-border bg-surface-inset'}`}
      {...markProps(false, recommended)}
    >
      <span className="min-w-0 text-console-14 font-semibold text-text-primary [overflow-wrap:anywhere]">
        {humaniseId(option.id)}
      </span>
      {recommended ? <RecommendedBadge /> : null}
      {option.does === '' ? null : <span className={WORDS}>{option.does}</span>}
      {option.cost === undefined ? null : <span className={WORDS}>Cost: {option.cost}</span>}
    </li>
  );
}
