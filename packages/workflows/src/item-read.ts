/**
 * The read of one item (`workflow runs --item`): its runs, the questions open in them, and
 * the answers recorded in them with the rulings recorded on the item, each oldest first.
 * Where the item stands is left to the reader; this computes no position and stores nothing.
 */
import { z } from 'zod';
import {
  attentionQueueItemSchema,
  compareAge,
  isHeldByRun,
  listAttentionQueue,
  type AttentionQueueSource,
} from './attention-queue';
import { attentionDegradedSchema, splitAttentionRead } from './schemas/attention-degraded';
import {
  itemRulingDegradedSchema,
  itemRulingSchema,
  type ItemRulingDegraded,
  type ItemRuling,
} from './schemas/item-ruling';
import { recordSurfaceSchema } from './schemas/record-surface';
import { workflowRunOutcomeSchema, workflowRunStatusSchema } from './schemas/run-status';
import {
  attentionAnswererSchema,
  attentionAnsweringRunSchema,
  attentionAnswerSchema,
  workflowItemSchema,
  type WorkflowRun,
} from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { IWorkflowStore } from './store';

export const itemRunSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  status: workflowRunStatusSchema,
  outcome: workflowRunOutcomeSchema.nullable(),
  startedAt: z.string().datetime(),
  /** Null while the run has not ended. */
  completedAt: z.string().datetime().nullable(),
});
export type ItemRun = z.infer<typeof itemRunSchema>;

/**
 * Where an answer was recorded. A field the event row does not carry is null, so an older
 * row still reads as an answer with its run, node and time.
 */
const answerFields = {
  runId: z.string(),
  node: z.string().nullable(),
  occurrence: z.string().nullable(),
  at: z.string(),
  via: recordSurfaceSchema.nullable(),
};

/**
 * One recorded answer: `attention` answers a question (`wait_answered`), `gate` resolves an
 * approval gate (`approval_received`), `ruling` is a decision recorded on the item with no
 * question asked (`ItemRuling`), which no run holds. `text` on a gate is its comment, or a
 * rejection's reason. A withdrawn ruling stays, with `withdrawn` set.
 */
export const itemAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attention'),
    ...answerFields,
    answer: attentionAnswerSchema.nullable(),
    by: attentionAnswererSchema.nullable(),
    /** Reported from the answering run's environment and not verified. */
    fromRun: attentionAnsweringRunSchema.nullable(),
  }),
  z.object({
    kind: z.literal('gate'),
    ...answerFields,
    decision: z.string().nullable(),
    text: z.string().nullable(),
  }),
  itemRulingSchema,
]);
export type ItemAnswer = z.infer<typeof itemAnswerSchema>;

/**
 * An item and what is recorded about it. `runs` are the item's own readable runs; a
 * `workflow:` child is left to `workflow get` on its parent. `questions` and `answers` come from the
 * whole run tree, because a question is often asked inside a child; each names the run
 * that holds it. `degraded` names each part that could not be read: one of the item's own
 * runs, a paused run the queue could not read (`run_unreadable`, by `runId`), or a ruling
 * (`ruling_unreadable`, by `rulingId`). The rest still reads.
 */
export const itemReadSchema = z.object({
  item: workflowItemSchema,
  runs: z.array(itemRunSchema),
  questions: z.array(attentionQueueItemSchema),
  answers: z.array(itemAnswerSchema),
  degraded: z.array(
    z.discriminatedUnion('reason', [attentionDegradedSchema, itemRulingDegradedSchema])
  ),
});
export type ItemRead = z.infer<typeof itemReadSchema>;

export interface ItemReadSource extends AttentionQueueSource {
  store: AttentionQueueSource['store'] &
    Pick<IWorkflowStore, 'getItemRuns' | 'listEventsForRuns' | 'listItemRulings'>;
}

function itemRun(run: WorkflowRun): ItemRun {
  return {
    id: run.id,
    workflow: run.workflow_name,
    status: run.status,
    outcome: run.outcome,
    startedAt: run.started_at.toISOString(),
    completedAt: run.completed_at?.toISOString() ?? null,
  };
}

function field<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function itemAnswer(row: WorkflowEventRow): ItemAnswer {
  const { data } = row;
  const base = {
    runId: row.workflow_run_id,
    node: row.step_name,
    occurrence: field(z.string(), data.occurrence),
    at: row.created_at,
    via: field(recordSurfaceSchema, data.via),
  };
  if (row.event_type === 'wait_answered')
    return {
      kind: 'attention',
      ...base,
      answer: field(attentionAnswerSchema, data.answer),
      by: field(attentionAnswererSchema, data.by),
      fromRun: field(attentionAnsweringRunSchema, data.fromRun),
    };
  return {
    kind: 'gate',
    ...base,
    decision: field(z.string(), data.decision),
    // Approve and respond record `comment`; reject records `reason`.
    text: field(z.string(), data.comment) ?? field(z.string(), data.reason),
  };
}

/** Read the item `key` names in project `projectKey`; null when there is no such item. */
export async function readItem(
  source: ItemReadSource,
  projectKey: string,
  key: string
): Promise<ItemRead | null> {
  const found = await source.store.getItemRuns(projectKey, key);
  if (found === null) return null;
  const own = splitAttentionRead(found.runs);
  const tree = new Set([
    ...own.values.map(run => run.id),
    ...own.degraded.map(report => report.runId),
    ...found.descendantIds,
  ]);
  // The one queue reader, so a question here reads as `workflow attention` lists it.
  const { values, degraded } = splitAttentionRead(await listAttentionQueue(source));
  const questions = values
    .filter(item => isHeldByRun(item) && tree.has(item.run.id))
    .sort(compareAge);
  const events =
    tree.size === 0
      ? new Map<string, WorkflowEventRow[]>()
      : await source.store.listEventsForRuns([...tree], ['wait_answered', 'approval_received']);
  const rulings: ItemRuling[] = [];
  const unreadableRulings: ItemRulingDegraded[] = [];
  for (const read of await source.store.listItemRulings(found.item.id))
    if ('type' in read) unreadableRulings.push(read);
    else rulings.push(read);
  const answers = [...[...events.values()].flat().map(itemAnswer), ...rulings]
    // Stable, so rows of one run within the same second keep their append order.
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    item: found.item,
    runs: own.values.map(itemRun),
    questions,
    answers,
    // A paused item run the store could not read is in both reports; list it once.
    degraded: [
      ...own.degraded,
      ...degraded.filter(
        report => tree.has(report.runId) && !own.degraded.some(mine => mine.runId === report.runId)
      ),
      ...unreadableRulings,
    ],
  };
}

/**
 * Read the item the run `runId` belongs to: the item of its root run, since a `workflow:`
 * child carries no item of its own. Null when the run is unknown or its root names no item.
 */
export async function readItemOfRun(
  source: ItemReadSource,
  runId: string
): Promise<ItemRead | null> {
  let run = await source.store.getWorkflowRun(runId);
  // `seen` keeps a corrupted `parent_run_id` cycle from looping, as `runTree` does.
  const seen = new Set<string>();
  while (run?.parent_run_id && !seen.has(run.id)) {
    seen.add(run.id);
    run = await source.store.getWorkflowRun(run.parent_run_id);
  }
  if (!run?.item_id) return null;
  const item = await source.store.getItem(run.item_id);
  return item === null ? null : readItem(source, item.projectKey, item.key);
}
