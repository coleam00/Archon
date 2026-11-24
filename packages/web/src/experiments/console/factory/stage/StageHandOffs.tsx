import type { ReactElement } from 'react';
import { stageHandOffs } from '../lib/stage-hand-offs';
import type { FactoryViewListed } from '../lib/views';

/**
 * "Where items go from here": each arrow out of the stage as the view file words it, "<label>
 * → <stage>", one chip each. It is where every outcome a map pill folds into "+N" reads in
 * full. Nothing when the stage declares no arrow out.
 */
export function StageHandOffs({
  view,
  stage,
}: {
  view: FactoryViewListed['declaration'];
  stage: string;
}): ReactElement | null {
  const handOffs = stageHandOffs(view, stage);
  if (handOffs.length === 0) return null;
  return (
    <section aria-label="Where items go from here" className="flex flex-col gap-1.5">
      <h4 className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        Where items go from here
      </h4>
      <ul className="flex flex-wrap gap-1.5">
        {handOffs.map(handOff => (
          <li
            key={`${handOff.label ?? ''}→${handOff.to}`}
            data-hand-off={handOff.to}
            className="rounded-full border border-border bg-surface-inset px-2.5 py-0.5 text-console-12 text-text-secondary"
          >
            {handOff.label === undefined
              ? `→ ${handOff.toLabel}`
              : `${handOff.label} → ${handOff.toLabel}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
