/**
 * Counts over the attention queue: how many open items, or started attention waits, fall
 * under each project, label value or answerer.
 */
import { z } from 'zod';
import {
  compareAttentionStrings,
  inAttentionQuery,
  projectRefSchema,
  runProject,
  type AttentionQueueCountBy,
  type AttentionQueueItem,
  type AttentionQueueQuery,
  type CodebaseCache,
} from './attention-queue';
import { attentionLabelsSchema } from './schemas/wait-node';
import { attentionAnswererSchema, type AttentionAnswerer } from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { IWorkflowStore } from './store';
import { attentionAnswerRecordSchema, attentionAskRecordSchema } from './store/attention-writes';

/** What events say became of one started attention wait. */
interface AskOutcome {
  /** Null while the wait is unanswered, and for an answer that recorded nobody. */
  answeredBy: AttentionAnswerer | null;
  /** Absent when the wait recorded no recommendation. */
  recommendation?: { answered: boolean; followed: boolean };
}

/**
 * What scope, label filters and counts read of an item. `outcome` is set only on a
 * started wait read from events (`countAttentionWaitStarts`); an open item has none.
 */
type AttentionCounted = Pick<AttentionQueueItem, 'project' | 'labels'> & { outcome?: AskOutcome };

/**
 * How a group's asks fared against their recommendations: `asked` carried one, `answered`
 * of those were answered, and `followed` of those chose the recommended option. Only a
 * count of started waits reports it; a wait started before recommendations were recorded
 * on its event counts as carrying none.
 */
const recommendationCountsSchema = z.object({
  asked: z.number().int(),
  answered: z.number().int(),
  followed: z.number().int(),
});
type RecommendationCounts = z.infer<typeof recommendationCountsSchema>;
const groupCountFields = {
  count: z.number().int(),
  recommendations: recommendationCountsSchema.optional(),
};

const countsByProjectSchema = z.object({
  by: z.literal('project'),
  counts: z.array(z.object({ project: projectRefSchema.nullable(), ...groupCountFields })),
});
const countsByLabelSchema = z.object({
  by: z.literal('label'),
  key: z.string(),
  /** `value` is null for the items that have no such label. */
  counts: z.array(z.object({ value: z.string().nullable(), ...groupCountFields })),
});

/** The counts of the items open now. They have no answer yet, so none groups by answerer. */
export const openAttentionQueueCountsSchema = z.discriminatedUnion('by', [
  countsByProjectSchema,
  countsByLabelSchema,
]);

export const attentionQueueCountsSchema = z.discriminatedUnion('by', [
  countsByProjectSchema,
  countsByLabelSchema,
  z.object({
    by: z.literal('answerer'),
    /** `answeredBy` is null for waits still open and for answers that recorded nobody. */
    counts: z.array(
      z.object({ answeredBy: attentionAnswererSchema.nullable(), ...groupCountFields })
    ),
  }),
]);
export type AttentionQueueCounts = z.infer<typeof attentionQueueCountsSchema>;

/**
 * How many items `query` selects under each project, each value of one label, or each
 * answerer, most first. Projects group by the scope rule: a codebase id when the item has
 * one, else its key. A group shows the project of its first item in `items`' order.
 */
export function countAttentionQueue(
  items: readonly AttentionCounted[],
  query: AttentionQueueQuery & { countBy: AttentionQueueCountBy }
): AttentionQueueCounts {
  const selected = items.filter(item => inAttentionQuery(item, query));
  const { countBy } = query;
  switch (countBy.by) {
    case 'project':
      return {
        by: 'project',
        counts: tally(
          selected,
          item => item.project,
          project =>
            project === null
              ? 'none'
              : project.codebaseId !== null
                ? `codebase:${project.codebaseId}`
                : `key:${project.key}`,
          project => project?.key ?? ''
        ).map(({ group, ...counts }) => ({ project: group, ...counts })),
      };
    case 'label': {
      const { key } = countBy;
      return {
        by: 'label',
        key,
        counts: tally(
          selected,
          item => (Object.hasOwn(item.labels, key) ? (item.labels[key] ?? '') : null),
          value => JSON.stringify(value),
          value => value ?? ''
        ).map(({ group, ...counts }) => ({ value: group, ...counts })),
      };
    }
    case 'answerer':
      return {
        by: 'answerer',
        counts: tally(
          selected,
          item => item.outcome?.answeredBy ?? null,
          answerer => JSON.stringify(answerer),
          answerer =>
            answerer === null ? '' : 'declared' in answerer ? answerer.declared : answerer.userId
        ).map(({ group, ...counts }) => ({ answeredBy: group, ...counts })),
      };
  }
  return countBy satisfies never;
}

/** One entry per group of `items`, largest first, then by `sortKey`. */
function tally<Group>(
  items: readonly AttentionCounted[],
  groupOf: (item: AttentionCounted) => Group,
  idOf: (group: Group) => string,
  sortKey: (group: Group) => string
): { group: Group; count: number; recommendations?: RecommendationCounts }[] {
  const groups = new Map<
    string,
    { group: Group; count: number; recommendations?: RecommendationCounts }
  >();
  for (const item of items) {
    const group = groupOf(item);
    const id = idOf(group);
    const entry = groups.get(id) ?? { group, count: 0 };
    groups.set(id, entry);
    entry.count += 1;
    if (item.outcome === undefined) continue;
    const totals = (entry.recommendations ??= { asked: 0, answered: 0, followed: 0 });
    const { recommendation } = item.outcome;
    if (recommendation === undefined) continue;
    totals.asked += 1;
    if (recommendation.answered) totals.answered += 1;
    if (recommendation.followed) totals.followed += 1;
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || compareAttentionStrings(sortKey(a.group), sortKey(b.group))
  );
}

/**
 * `countAttentionQueue` over every attention wait started at or after `since`, answered
 * or still open, from events alone: the labels and ask record each `wait_started` row
 * opened with, and the `wait_answered` row of the same occurrence. A wait started before
 * labels or the ask record were recorded counts as having no labels and no recommendation.
 */
export async function countAttentionWaitStarts(
  source: {
    store: Pick<
      IWorkflowStore,
      'listAttentionWaitStarts' | 'getWorkflowRunsByIds' | 'getCodebase' | 'listEventsForRuns'
    >;
  },
  query: AttentionQueueQuery & { countBy: AttentionQueueCountBy; since?: Date }
): Promise<AttentionQueueCounts> {
  const { since } = query;
  const starts = (await source.store.listAttentionWaitStarts()).filter(
    start => since === undefined || Date.parse(start.startedAt) >= since.getTime()
  );
  const runIds = [...new Set(starts.map(start => start.runId))];
  const runs = new Map((await source.store.getWorkflowRunsByIds(runIds)).map(run => [run.id, run]));
  const answers = await source.store.listEventsForRuns(runIds, ['wait_answered']);
  const codebases: CodebaseCache = new Map();
  const counted: AttentionCounted[] = [];
  for (const start of starts) {
    const run = runs.get(start.runId);
    if (run === undefined) continue;
    const labels = attentionLabelsSchema.safeParse(start.data.labels);
    counted.push({
      project: await runProject(source, run, codebases),
      labels: labels.success ? labels.data : {},
      outcome: askOutcome(start.data, answers.get(start.runId) ?? []),
    });
  }
  return countAttentionQueue(counted, query);
}

/** What became of the wait a `wait_started` row opened, from its run's `wait_answered` rows. */
function askOutcome(
  started: Record<string, unknown>,
  answered: readonly Pick<WorkflowEventRow, 'data'>[]
): AskOutcome {
  const ask = attentionAskRecordSchema.safeParse(started);
  if (!ask.success) return { answeredBy: null };
  let answer: z.infer<typeof attentionAnswerRecordSchema> | undefined;
  for (const row of answered) {
    const record = attentionAnswerRecordSchema.safeParse(row.data);
    if (record.success && record.data.occurrence === ask.data.occurrence) answer = record.data;
  }
  const recommended = ask.data.recommendation?.option;
  return {
    answeredBy: answer?.by ?? null,
    ...(recommended === undefined
      ? {}
      : {
          recommendation: {
            answered: answer !== undefined,
            followed:
              answer !== undefined &&
              'decision' in answer.answer &&
              answer.answer.decision === recommended,
          },
        }),
  };
}
