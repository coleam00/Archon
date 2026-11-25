import type { ReactElement } from 'react';
import type { CuratedDrilldownCard as Card, CuratedView } from '../lib/curated-view';
import { engineIdTitle, stepLabel } from '../lib/step-label';
import { cardTone } from '../tones';
import { ICONS, KINDS } from './drilldown-kinds';

/**
 * One card of a drill-down: its kind's colour along the top, its icon and kind, its title and
 * line of text. It is plain text: a step has no page of its own (DESIGN.md, v2 direction). Its
 * box is `.factory-card`'s (factory.css), tinted in its kind's colour.
 */
export function DrilldownCard({ view, card }: { view: CuratedView; card: Card }): ReactElement {
  const kind = KINDS[card.kind];
  const Icon = ICONS[card.icon];
  const workflow = card.covers[0]?.workflow;
  const step = card.covers[0]?.steps[0];
  // The schema holds `covers` to at least one step.
  if (workflow === undefined || step === undefined)
    throw new Error(`The drill-down card "${card.title}" stands for no step`);
  const label = stepLabel(view, workflow, step);
  return (
    <article
      data-drilldown-card={card.title}
      className="factory-card relative flex flex-col overflow-hidden rounded-console-12 border"
      style={cardTone(kind.color)}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ background: kind.color }}
      />
      <div title={engineIdTitle(label, step)} className="flex flex-col gap-2 p-4 text-left">
        <span className="flex items-center gap-2 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
          <Icon aria-hidden="true" className="size-4 shrink-0" style={{ color: kind.color }} />
          {kind.label}
        </span>
        <span className="line-clamp-2 text-console-15 font-semibold leading-snug text-text-primary">
          {card.title}
        </span>
        <span title={card.text} className="line-clamp-2 text-console-13 text-text-secondary">
          {card.text}
        </span>
      </div>
    </article>
  );
}
