/**
 * Whether a factory view's drill-downs tell their own stages (`factory-view.ts` owns their
 * shape). Split from `factory-view.ts` for size.
 */

type Issue = { path: (string | number)[]; message: string };

interface DrilldownView {
  stages: readonly {
    id: string;
    workflows: readonly string[];
    drilldown?: {
      phases: readonly { cards: readonly { covers: readonly { workflow: string }[] }[] }[];
      loop?: { from: number; to: number; workflow: string };
    };
  }[];
}

/**
 * A drill-down tells its own stage: each card covers, and its loop names, a workflow the
 * stage lists, and the loop spans phases it has. Whether a step is real only the coverage
 * check can say, from the pack's workflows.
 */
export function drilldownIssues(view: DrilldownView): Issue[] {
  const issues: Issue[] = [];
  view.stages.forEach((stage, s) => {
    const { drilldown } = stage;
    if (drilldown === undefined) return;
    const at = ['stages', s, 'drilldown'];
    const own = (path: Issue['path'], workflow: string): void => {
      if (!stage.workflows.includes(workflow))
        issues.push({
          path,
          message: `names workflow "${workflow}", which stage "${stage.id}" does not list`,
        });
    };
    drilldown.phases.forEach((phase, p) => {
      phase.cards.forEach((card, c) => {
        card.covers.forEach((cover, k) => {
          own([...at, 'phases', p, 'cards', c, 'covers', k, 'workflow'], cover.workflow);
        });
      });
    });
    const { loop } = drilldown;
    if (loop === undefined) return;
    own([...at, 'loop', 'workflow'], loop.workflow);
    if (loop.from > loop.to || loop.to > drilldown.phases.length)
      issues.push({
        path: [...at, 'loop'],
        message: `spans phases ${String(loop.from)} to ${String(loop.to)}; the drill-down has phases 1 to ${String(drilldown.phases.length)}`,
      });
  });
  return issues;
}
