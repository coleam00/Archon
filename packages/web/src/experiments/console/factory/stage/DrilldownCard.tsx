import type { ReactElement } from 'react';
import { Link } from 'react-router';
import type { DrilldownCard as Card } from '../lib/drilldown-live';
import type { ItemOnStep } from '../lib/items-on-step';
import { stepPagePath, type StepPageState } from '../lib/stage-steps';
import { engineIdTitle, stepLabel } from '../lib/step-label';
import type { FactoryViewListed } from '../lib/views';
import { RunningItemLinks } from '../RunningItems';
import { ShadowBadge } from '../ShadowBadge';
import { cardTone } from '../tones';
import { ICONS, KINDS } from './drilldown-kinds';

/**
 * One card of a drill-down: its kind's colour along the top, its icon and kind, its title and
 * line of text. The card is a link to the step page of the main step it stands for, the first
 * its first cover names, which leads back to this stage; the items on it now are named under
 * it, outside the link, since each is a link too. While items are on it, it wears the step
 * graph's running border and ring (`data-running`, the same tokens as RUNNING_GLOW), held still:
 * the items read carries no owner liveness. Its box is `.factory-card`'s (theme.css), tinted in
 * its kind's colour. A card standing for a shadow step (rule 10) carries the shadow badge and a
 * `--node-opaque` bar and tint, and says what it decided lately.
 */
export function DrilldownCard({
  view,
  projectId,
  stageId,
  card,
  onCard,
  shadow,
}: {
  view: FactoryViewListed['declaration'];
  projectId: string;
  /** The stage whose drill-down holds the card: the step page's back link returns to it. */
  stageId: string;
  card: Card;
  /** The items on a step the card covers now; empty when none, or when the read failed. */
  onCard: readonly ItemOnStep[];
  /**
   * Set when the card stands for a shadow step: `lately` is what it decided on the newest
   * items ("last 5: would ask you first ×5"), one line per shadow it covers; empty when none.
   */
  shadow: { lately: readonly string[] } | null;
}): ReactElement {
  const kind = KINDS[card.kind];
  const Icon = ICONS[card.icon];
  const live = onCard.length > 0;
  const tone = shadow === null ? kind.color : 'var(--node-opaque)';
  const workflow = card.covers[0]?.workflow;
  const step = card.covers[0]?.steps[0];
  // The schema holds `covers` and each cover's `steps` to at least one.
  if (workflow === undefined || step === undefined)
    throw new Error(`The drill-down card "${card.title}" stands for no step`);
  const label = stepLabel(view, workflow, step);
  return (
    <article
      data-live={live ? 'true' : undefined}
      data-running={live ? '' : undefined}
      // Its hover border is theme.css's `.factory-card[data-link]:hover`.
      data-link=""
      className="factory-card relative flex flex-col overflow-hidden rounded-console-12 border"
      style={cardTone(tone)}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ background: tone }}
      />
      <Link
        to={stepPagePath(projectId, workflow, step)}
        state={{ fromStage: stageId } satisfies StepPageState}
        title={engineIdTitle(label, step)}
        className="flex cursor-pointer flex-col gap-2 p-4 text-left transition-colors duration-150 ease-out hover:bg-surface-elevated"
      >
        <span className="flex items-center gap-2 text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
          <Icon aria-hidden="true" className="size-4 shrink-0" style={{ color: kind.color }} />
          {kind.label}
          {shadow === null ? null : <ShadowBadge className="ml-auto normal-case tracking-normal" />}
        </span>
        <span className="line-clamp-2 text-console-15 font-semibold leading-snug text-text-primary">
          {card.title}
        </span>
        <span title={card.text} className="line-clamp-2 text-console-13 text-text-secondary">
          {card.text}
        </span>
        {shadow?.lately.map(line => (
          <span key={line} className="text-console-13 text-text-tertiary">
            {line}
          </span>
        ))}
      </Link>
      {live ? (
        <div className="border-t border-border px-4 py-2.5">
          <RunningItemLinks view={view} projectId={projectId} items={onCard} />
        </div>
      ) : null}
    </article>
  );
}
