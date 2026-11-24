import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];

/** One arrow out of a stage, in the view file's words. */
interface HandOff {
  /** The arrow's label; undefined for an unlabelled one. */
  label: string | undefined;
  /** The stage it goes to, by id and by its label. */
  to: string;
  toLabel: string;
}

/**
 * Where items go from a stage: every arrow the view file declares out of it into another stage,
 * in declared order. This is where a map pill's outcomes past its two lines are listed in full
 * (each comes from an arrow out of one of the pill's left card's stages). An arrow back into the
 * stage itself goes nowhere and is left out.
 */
export function stageHandOffs(view: Declaration, stageId: string): HandOff[] {
  return view.map.arrows
    .filter(arrow => arrow.from === stageId && arrow.to !== stageId)
    .map(arrow => ({
      label: arrow.label,
      to: arrow.to,
      // The schema refuses an arrow into an undeclared stage; the id stands in for safety.
      toLabel: view.stages.find(stage => stage.id === arrow.to)?.label ?? arrow.to,
    }));
}
