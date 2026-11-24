import type { FactoryItem } from '../../skills/factory';
import { itemsOnStep, type ItemOnStep } from './items-on-step';
import type { FactoryStage } from './stage-steps';

export type FactoryDrilldown = NonNullable<FactoryStage['drilldown']>;
export type DrilldownCard = FactoryDrilldown['phases'][number]['cards'][number];

/** The items on a drill-down now: `cards[p][c]` on card `c` of phase `p`, `loop` between rounds. */
export interface DrilldownLive {
  cards: ItemOnStep[][][];
  loop: ItemOnStep[];
}

/**
 * Where each running item sits on a drill-down: a card holds the items whose running step is
 * one it covers, matched exactly as `itemsOnStep` keys them, and the loop holds a run between
 * its rounds (the read names the loop group then). The coverage check puts each real step on
 * one card, so an item lands on at most one. A run between steps, or on a step another
 * stage's drill-down covers, lands on nothing here.
 */
export function drilldownLive(
  drilldown: FactoryDrilldown,
  items: readonly FactoryItem[]
): DrilldownLive {
  const byWorkflow = new Map<string, Map<string, ItemOnStep[]>>();
  const onStep = (workflow: string, step: string): ItemOnStep[] => {
    let steps = byWorkflow.get(workflow);
    if (steps === undefined) {
      steps = itemsOnStep(items, workflow);
      byWorkflow.set(workflow, steps);
    }
    return steps.get(step) ?? [];
  };
  return {
    cards: drilldown.phases.map(phase =>
      phase.cards.map(card =>
        card.covers.flatMap(cover => cover.steps.flatMap(step => onStep(cover.workflow, step)))
      )
    ),
    loop: drilldown.loop === undefined ? [] : onStep(drilldown.loop.workflow, drilldown.loop.step),
  };
}
