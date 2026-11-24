/**
 * What the item page needs of one run to tell its story, beyond its facts on the board: what
 * the run said in its own words (at the view's `story.said` pointers into its result), the
 * models its steps ran on, and when each step started, so a run that works several stages
 * (a loop-form delivery) can be split across them. Placing a step on a stage is the console's
 * (`stageOfWorkflow`), so this sends the step ids as the engine records them and places none.
 */
import { z } from 'zod';
import { resultString } from './factory-parked';
import type { ItemReadSource } from './item-read';
import type { FactoryView } from './schemas/factory-view';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowEventType } from './store/event-types';
import type { WorkflowRun } from './schemas/workflow-run';
import { parseDbTimestamp } from './utils/duration';

/** The event types `factoryRunStory` reads. */
const FACTORY_RUN_STORY_EVENT_TYPES: readonly WorkflowEventType[] = [
  'node_started',
  'node_completed',
  'workflow_completed',
];

/** The item read's run fields this fills (`factoryItemRunSchema` spreads them). */
export const factoryRunStoryShape = {
  /** The first non-empty string at a `story.said` pointer in the run's result; else null. */
  said: z.string().nullable(),
  /** The distinct models the run's completed steps recorded, in first-recorded order. */
  models: z.array(z.string()),
  /** Each step start, in event order, as the engine records the step id, with its ISO time. */
  steps: z.array(z.object({ node: z.string(), startedAt: z.string().datetime() })),
};
type FactoryRunStory = z.infer<z.ZodObject<typeof factoryRunStoryShape>>;

/** The story facts of one run, from its events of `FACTORY_RUN_STORY_EVENT_TYPES` in append order. */
export function factoryRunStory(
  view: FactoryView,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): FactoryRunStory {
  const said =
    (view.story?.said ?? []).map(pointer => resultString(pointer, run, events)).find(Boolean) ??
    null;
  const models: string[] = [];
  const steps: FactoryRunStory['steps'] = [];
  for (const row of events) {
    if (row.event_type === 'node_started' && row.step_name)
      steps.push({
        node: row.step_name,
        startedAt: new Date(parseDbTimestamp(row.created_at)).toISOString(),
      });
    const model = row.event_type === 'node_completed' ? row.data.model : undefined;
    if (typeof model === 'string' && model !== '' && !models.includes(model)) models.push(model);
  }
  return { said, models, steps };
}

/**
 * The story facts of one item's runs, from one events read. Only the item page reads them, so
 * neither the board's progress read nor its facts memo carries them.
 */
export async function runStories(
  source: ItemReadSource,
  view: FactoryView,
  runs: readonly WorkflowRun[]
): Promise<Map<string, FactoryRunStory>> {
  const events = await source.store.listEventsForRuns(
    runs.map(run => run.id),
    FACTORY_RUN_STORY_EVENT_TYPES
  );
  return new Map(runs.map(run => [run.id, factoryRunStory(view, run, events.get(run.id) ?? [])]));
}
