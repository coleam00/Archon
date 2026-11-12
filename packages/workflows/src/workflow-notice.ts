/**
 * A notice: a short message about a run, emitted by a node or engine admission, for whoever
 * watches the attention stream. It asks nothing of its reader: it never pauses the run,
 * holds no slot and cannot be answered. Each one is a `workflow_notice` event of its run,
 * so it is durable, ordered with the run's other events and countable by label like an ask.
 */
import { z } from 'zod';
import {
  countAttentionQueue,
  isInAttentionScope,
  matchesAttentionLabels,
  projectRefSchema,
  runProject,
  type AttentionQueueCountBy,
  type AttentionQueueCounts,
  type AttentionQueueQuery,
} from './attention-queue';
import { attentionLabelsSchema } from './schemas/wait-node';
import type { IWorkflowStore } from './store';

/**
 * The bounds that keep notices from becoming a log: one short line of text, a handful of
 * short labels, and a ceiling per run. An emit past any of them is refused.
 */
export const WORKFLOW_NOTICE_LIMITS = {
  textLength: 300,
  labels: 16,
  labelValueLength: 200,
  perRun: 50,
} as const;

/** A notice prints as one terminal line: a control character could break or rewrite it. */
function isPrintable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return false;
  }
  return true;
}

/** What a `workflow_notice` event records in its `data`. */
export const workflowNoticeDataSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'A notice needs text')
    .max(
      WORKFLOW_NOTICE_LIMITS.textLength,
      `A notice is at most ${String(WORKFLOW_NOTICE_LIMITS.textLength)} characters`
    )
    .refine(text => !/[\r\n]/u.test(text), 'A notice is one line')
    .refine(isPrintable, 'A notice has no control characters'),
  labels: attentionLabelsSchema
    .refine(
      labels => Object.keys(labels).length <= WORKFLOW_NOTICE_LIMITS.labels,
      `A notice takes at most ${String(WORKFLOW_NOTICE_LIMITS.labels)} labels`
    )
    .refine(
      labels =>
        Object.values(labels).every(
          value => value.length <= WORKFLOW_NOTICE_LIMITS.labelValueLength
        ),
      `A notice label value is at most ${String(WORKFLOW_NOTICE_LIMITS.labelValueLength)} characters`
    )
    .refine(
      labels => Object.entries(labels).every(([key, value]) => isPrintable(key + value)),
      'A notice label has no control characters or line breaks'
    ),
  /** The path of the node that emitted it. */
  node: z.string().nullable(),
});
export type WorkflowNoticeData = z.infer<typeof workflowNoticeDataSchema>;

/** A notice as a reader receives it: what was said, when, and by which run. */
export const workflowNoticeSchema = workflowNoticeDataSchema.extend({
  /** When the run emitted it. */
  at: z.string(),
  runId: z.string(),
  workflow: z.string(),
  parentRunId: z.string().nullable(),
  project: projectRefSchema.nullable(),
});
export type WorkflowNotice = z.infer<typeof workflowNoticeSchema>;

/** The emit was well formed and the engine did not record it. */
export class WorkflowNoticeRefusedError extends Error {
  constructor(
    readonly reason: 'invalid' | 'run_not_running' | 'run_limit',
    message: string
  ) {
    super(message);
    this.name = 'WorkflowNoticeRefusedError';
  }
}

export function assertWorkflowNoticeLimit(runId: string, emittedCount: number): void {
  const limit = WORKFLOW_NOTICE_LIMITS.perRun;
  if (emittedCount >= limit)
    throw new WorkflowNoticeRefusedError(
      'run_limit',
      `Run ${runId} has emitted ${String(limit)} notices, the most one run may. A notice says what a run did; details belong in an artifact.`
    );
}

/**
 * Record a notice for a running run; `count` is how many the run has emitted with it.
 * Throws `WorkflowNoticeRefusedError` for text or labels outside the bounds, and when the
 * run is past its ceiling or is not running; its message never repeats the text. The
 * ceiling is read before the write, so nodes emitting at the same moment can pass it by
 * the few that raced.
 */
export async function emitWorkflowNotice(
  store: Pick<IWorkflowStore, 'listEventsForRuns' | 'persistWorkflowEventIfRunning'>,
  input: { runId: string } & z.input<typeof workflowNoticeDataSchema>
): Promise<{ runId: string; count: number; limit: number }> {
  const { runId, ...rest } = input;
  const parsed = workflowNoticeDataSchema.safeParse(rest);
  if (!parsed.success)
    throw new WorkflowNoticeRefusedError(
      'invalid',
      parsed.error.issues[0]?.message ?? 'Invalid notice'
    );
  const data = parsed.data;
  const limit = WORKFLOW_NOTICE_LIMITS.perRun;
  const emitted = (await store.listEventsForRuns([runId], ['workflow_notice'])).get(runId) ?? [];
  assertWorkflowNoticeLimit(runId, emitted.length);
  const { persisted } = await store.persistWorkflowEventIfRunning({
    workflow_run_id: runId,
    event_type: 'workflow_notice',
    ...(data.node === null ? {} : { step_name: data.node }),
    data,
  });
  if (!persisted)
    throw new WorkflowNoticeRefusedError(
      'run_not_running',
      `Run ${runId} is not running, so it cannot emit a notice.`
    );
  return { runId, count: emitted.length + 1, limit };
}

/** What a run last said, as its row in a run list carries it. */
export const latestWorkflowNoticeSchema = workflowNoticeDataSchema.extend({ at: z.string() });
export type LatestWorkflowNotice = z.infer<typeof latestWorkflowNoticeSchema>;

/**
 * The latest notice of each of `runIds` that emitted one: what a live run is about, for
 * a run list, read in one batch so the list does not read each run's history.
 */
export async function latestWorkflowNotices(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  runIds: readonly string[]
): Promise<Map<string, LatestWorkflowNotice>> {
  const latest = new Map<string, LatestWorkflowNotice>();
  if (runIds.length === 0) return latest;
  for (const [runId, rows] of await store.listEventsForRuns(runIds, ['workflow_notice'])) {
    for (const row of rows) {
      const data = workflowNoticeDataSchema.safeParse(row.data);
      if (data.success) latest.set(runId, { ...data.data, at: row.created_at });
    }
  }
  return latest;
}

type NoticeSource = {
  store: Pick<IWorkflowStore, 'listWorkflowNoticeRows' | 'getWorkflowRunsByIds' | 'getCodebase'>;
};

/**
 * The notices emitted at or after `since` that `query` selects, oldest first. A row whose
 * data does not read as a notice is left out.
 */
export async function listWorkflowNotices(
  source: NoticeSource,
  query: AttentionQueueQuery & { since?: Date }
): Promise<WorkflowNotice[]> {
  const { since } = query;
  const rows = (await source.store.listWorkflowNoticeRows()).filter(
    row => since === undefined || Date.parse(row.at) >= since.getTime()
  );
  const runIds = [...new Set(rows.map(row => row.runId))];
  const runs = new Map((await source.store.getWorkflowRunsByIds(runIds)).map(run => [run.id, run]));
  const codebases = new Map();
  const notices: WorkflowNotice[] = [];
  for (const row of rows) {
    const run = runs.get(row.runId);
    const data = workflowNoticeDataSchema.safeParse(row.data);
    if (run === undefined || !data.success) continue;
    const project = await runProject(source, run, codebases);
    if (
      !isInAttentionScope(project, query.scope) ||
      !matchesAttentionLabels(data.data, query.labels)
    )
      continue;
    notices.push({
      ...data.data,
      at: row.at,
      runId: run.id,
      workflow: run.workflow_name,
      parentRunId: run.parent_run_id,
      project,
    });
  }
  return notices;
}

/** `listWorkflowNotices` counted by project or by one label's value, as asks are counted. */
export async function countWorkflowNotices(
  source: NoticeSource,
  query: AttentionQueueQuery & { since?: Date; countBy: AttentionQueueCountBy }
): Promise<AttentionQueueCounts> {
  return countAttentionQueue(await listWorkflowNotices(source, query), query);
}
