/**
 * The view's declarations about items held open and workflows retired (`factory-view.ts` owns
 * their shape). Split from `factory-view.ts` for size.
 */

type Issue = { path: (string | number)[]; message: string };

interface HeldView {
  stages: readonly { workflows: readonly string[] }[];
  placement: Record<string, string>;
  endings: Record<string, string>;
  parked?: Record<string, unknown>;
  awaits?: Record<string, unknown>;
  retired?: readonly string[];
}

/**
 * A `parked` or `awaits` outcome holds its item open, so it is placed, never ended: `placement`
 * takes it (exactly or by `workflow:*`), and no exact `endings` key names it, which placement,
 * checked first, would leave dead. One outcome is parked (idle by choice) or awaits a person,
 * not both: the two read differently, and which one won would be left to code order.
 */
export function heldOpenIssues(view: HeldView): Issue[] {
  const issues: Issue[] = [];
  for (const field of ['parked', 'awaits'] as const)
    for (const key of Object.keys(view[field] ?? {})) {
      const workflow = key.slice(0, key.lastIndexOf(':'));
      if (view.placement[key] === undefined && view.placement[`${workflow}:*`] === undefined)
        issues.push({ path: [field, key], message: `a ${field} outcome must be placed` });
      if (view.endings[key] !== undefined)
        issues.push({
          path: ['endings', key],
          message: `is declared ${field}; the item is open`,
        });
    }
  for (const key of Object.keys(view.awaits ?? {}))
    if (view.parked?.[key] !== undefined)
      issues.push({
        path: ['awaits', key],
        message: 'is declared parked too; it is one or the other',
      });
  return issues;
}

/**
 * A retired workflow is one a stage still lists, or its stored runs would place nowhere; each
 * is named once.
 */
export function retiredIssues(view: HeldView): Issue[] {
  const listed = new Set(view.stages.flatMap(stage => stage.workflows));
  const seen = new Set<string>();
  const issues: Issue[] = [];
  view.retired?.forEach((workflow, index) => {
    if (!listed.has(workflow))
      issues.push({
        path: ['retired', index],
        message: `names workflow "${workflow}", which no stage lists; a retired workflow's runs must still place`,
      });
    if (seen.has(workflow))
      issues.push({ path: ['retired', index], message: `workflow "${workflow}" is listed twice` });
    seen.add(workflow);
  });
  return issues;
}
