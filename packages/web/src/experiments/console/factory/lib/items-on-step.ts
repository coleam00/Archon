import type { FactoryItem } from '../../skills/factory';

type FactoryRunning = NonNullable<NonNullable<FactoryItem['progress']>['running']>;

/** An item a run of a declared workflow works now, and where that run is. */
export interface ItemOnStep {
  item: FactoryItem;
  running: FactoryRunning;
}

/**
 * The items a run of `workflow` (as the factory view names it) works now, in the read's
 * order. A run between steps (`step: null`) is included.
 */
export function runningItems(items: readonly FactoryItem[], workflow: string): ItemOnStep[] {
  const out: ItemOnStep[] = [];
  for (const item of items) {
    const running = item.progress?.running;
    if (running?.workflow === workflow) out.push({ item, running });
  }
  return out;
}

/**
 * The items on each step of `workflow` now, keyed by the running step exactly: a step key, or
 * a loop's id between its bodies. Exact, not `stepInStage`'s dotted prefix: the read already
 * names the deepest running step, so a loop body is never reported as its loop, and the
 * prefix rule answers which stage works a step, not which step is running.
 */
export function itemsOnStep(
  items: readonly FactoryItem[],
  workflow: string
): Map<string, ItemOnStep[]> {
  const steps = new Map<string, ItemOnStep[]>();
  for (const onStep of runningItems(items, workflow)) {
    const { step } = onStep.running;
    if (step === null) continue;
    const list = steps.get(step);
    if (list === undefined) steps.set(step, [onStep]);
    else list.push(onStep);
  }
  return steps;
}
