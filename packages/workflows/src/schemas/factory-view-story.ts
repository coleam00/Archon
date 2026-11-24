/**
 * Which workflows a factory view's `story` may word (`factory-view.ts` owns its shape): an
 * outcome key names a workflow a stage lists or the `discoveries` drain, whose runs the item
 * page tells too; a step key names a listed one. Split from `factory-view.ts` for size.
 */

interface StoryView {
  stages: readonly { workflows: readonly string[] }[];
  discoveries?: { workflow: string };
  story?: { outcomes: Record<string, unknown>; steps?: Record<string, unknown> };
}

export function storyReferenceIssues(
  view: StoryView
): { path: (string | number)[]; message: string }[] {
  if (view.story === undefined) return [];
  const workflows = new Set(view.stages.flatMap(stage => stage.workflows));
  const issues: { path: (string | number)[]; message: string }[] = [];
  const refer = (path: (string | number)[], workflow: string, drain: boolean): void => {
    if (workflows.has(workflow) || (drain && workflow === view.discoveries?.workflow)) return;
    issues.push({ path, message: `names workflow "${workflow}", which no stage lists` });
  };
  for (const key of Object.keys(view.story.outcomes))
    refer(['story', 'outcomes', key], key.slice(0, key.lastIndexOf(':')), true);
  for (const workflow of Object.keys(view.story.steps ?? {}))
    refer(['story', 'steps', workflow], workflow, false);
  return issues;
}
