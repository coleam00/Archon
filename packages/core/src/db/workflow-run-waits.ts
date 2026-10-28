/**
 * Durable waits on workflow runs: pausing a run on a persisted wait, the
 * continuations that resume it, and the signal, answer and label writes that
 * satisfy it. Re-exported from the `./workflows` entry.
 */
import {
  answeredPauseContinuation,
  pendingWorkflowWaitDeadline,
  readSourceRelease,
  SOURCE_RELEASE_METADATA_KEY,
  workflowWaitContextSchema,
  readWorkflowWaitContext,
  workflowWaitStepName,
  type WorkflowAttentionWaitContext,
  type WorkflowRun,
  type WorkflowWaitContext,
} from '@archon/workflows/schemas/workflow-run';
import { PAUSE_CAUSE_METADATA_KEY, pauseCauseOfWait } from '@archon/workflows/schemas/pause-cause';
import {
  answeredAttentionWait,
  attentionLabeledEvent,
  labeledAttentionWait,
  waitAnsweredEvent,
  waitCompletionEvents,
  waitContinuedEvent,
  type AttentionAnswerWrite,
  type AttentionLabelWrite,
  type NodeStateEventInput,
  type WorkflowResumeCursor,
  type WorkflowWaitCompletion,
  type WorkflowWaitPause,
} from '@archon/workflows/store';
import { getDatabase, getDatabaseType, getDialect, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { insertWorkflowEvent } from './workflow-events';
import {
  normalizeWorkflowRun,
  parseJsonObject,
  type WorkflowRunRow,
} from './workflow-run-normalization';
import { getLog, jsonIntExtract, lockedRunRow, normalizeMetadata } from './workflow-run-shared';

/** Replace the engine-owned wait object and remove any stale human approval. */
function replaceWaitMetadata(paramIndex: number, causeIndex: number): string {
  const value = `$${String(paramIndex)}`;
  const cause = `$${String(causeIndex)}`;
  const metadata = getDialect().jsonRemove('metadata', 'approval');
  return getDatabaseType() === 'postgresql'
    ? `jsonb_set(jsonb_set(${metadata}, '{wait}', ${value}::jsonb, true), '{${PAUSE_CAUSE_METADATA_KEY}}', to_jsonb(${cause}::text), true)`
    : `json_set(${metadata}, '$.wait', json(${value}), '$.${PAUSE_CAUSE_METADATA_KEY}', ${cause})`;
}

/** Pause a running run on a persisted wait condition. */
export async function pauseWorkflowRunForWait(
  id: string,
  waitContext: WorkflowWaitContext,
  pause: WorkflowWaitPause
): Promise<void> {
  const parsedWaitContext = workflowWaitContextSchema.parse(waitContext);
  try {
    await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'paused', metadata = ${replaceWaitMetadata(2, 3)}
         WHERE id = $1 AND status = 'running'`,
        [id, JSON.stringify(parsedWaitContext), pauseCauseOfWait(parsedWaitContext)]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(`Workflow run not found or not in running state (id: ${id})`);
      }
      if (pause.kind === 'started') {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'wait_started',
          step_name: pause.stepName,
          data: {
            kind: parsedWaitContext.kind,
            ...(parsedWaitContext.kind !== 'attention'
              ? { resume_at: parsedWaitContext.resumeAt }
              : {}),
            ...(parsedWaitContext.kind === 'event' ? { event: parsedWaitContext.event } : {}),
          },
        });
      } else {
        await insertWorkflowEvent(query, waitContinuedEvent(id, parsedWaitContext));
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_wait_pause_failed');
    throw new Error(`Failed to pause workflow run for wait: ${err.message}`);
  }
}

/** Atomically consume one exact wait cursor and persist its completed node snapshot. */
export async function clearWorkflowWaitContext(
  id: string,
  waitContext: WorkflowWaitContext,
  completion: WorkflowWaitCompletion
): Promise<{ cleared: false } | { cleared: true; nodeEvent: NodeStateEventInput }> {
  const dialect = getDialect();
  const nodeExpr = dialect.jsonText('metadata', 'wait.nodeId');
  const cursorExpr = dialect.jsonText(
    'metadata',
    `wait.${waitContext.kind === 'attention' ? 'waitingSince' : 'resumeAt'}`
  );
  const cursor = waitContext.kind === 'attention' ? waitContext.waitingSince : waitContext.resumeAt;
  const pauseIdExpr = dialect.jsonText('metadata', 'wait.pauseId');
  const occurrenceMatches =
    waitContext.pauseId === undefined ? `${pauseIdExpr} IS NULL` : `${pauseIdExpr} = $4`;
  const clearWait = dialect.jsonRemove('metadata', 'wait');
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${clearWait}
         WHERE id = $1 AND status = 'running' AND ${nodeExpr} = $2 AND ${cursorExpr} = $3 AND ${occurrenceMatches}`,
        [
          id,
          waitContext.nodeId,
          cursor,
          ...(waitContext.pauseId === undefined ? [] : [waitContext.pauseId]),
        ]
      );
      if ((result.rowCount ?? 0) === 0) return { cleared: false };
      const rows = waitCompletionEvents(id, completion);
      await insertWorkflowEvent(query, rows.outcome);
      await insertWorkflowEvent(query, rows.node);
      return { cleared: true, nodeEvent: rows.node };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_wait_clear_failed');
    throw new Error(`Failed to clear workflow wait: ${err.message}`);
  }
}

/**
 * Return a bounded set of runs eligible for a resume claim: due time, event and usage-limit
 * waits, due quota resumes an older binary scheduled, answered gates and attention waits,
 * and runs released for an unreadable source. The answered clauses mirror
 * `continuablePause`, which the host re-checks when it builds the claim's cursor.
 */
export async function listDueWorkflowContinuations(
  now: Date,
  limit: number
): Promise<WorkflowRun[]> {
  const dialect = getDialect();
  const metadataText = (path: string): string => dialect.jsonText('metadata', path);
  const resumeAt = metadataText('wait.resumeAt');
  const signaledAt = metadataText('wait.signaledAt');
  const waitKind = metadataText('wait.kind');
  const scheduledResumeAt = metadataText('scheduled_resume.resumeAt');
  const scheduledTriggeredAt = metadataText('scheduled_resume.triggeredAt');
  const retryAt = metadataText('continuation_retry_at');
  const answeredGate = `status = 'paused' AND ${metadataText('wait')} IS NULL
               AND COALESCE(${metadataText('isolation')}, '') <> 'container'
               AND ${metadataText('approval.resolved')} IN ('approved', 'rejected')
               AND ${metadataText('approval.pauseId')} IS NOT NULL
               AND COALESCE(${metadataText('approval.nodeId')}, '') <> ''
               AND COALESCE(${metadataText('approval.type')}, 'approval') NOT IN ('child_workflow', 'fan_out', 'writeback')`;
  const answeredAttention = `status = 'paused' AND ${waitKind} = 'attention'
               AND COALESCE(${metadataText('isolation')}, '') <> 'container'
               AND ${metadataText('wait.pauseId')} IS NOT NULL
               AND ${metadataText('wait.answer')} IS NOT NULL`;
  // Each row sorts by its own kind's time. A run resumed from a quota schedule keeps the
  // triggered schedule, which must not place a later answered pause among timed rows.
  const dueAt = `COALESCE(${retryAt}, CASE WHEN status = 'paused' THEN ${resumeAt} END,
               CASE WHEN status = 'failed' THEN ${scheduledResumeAt} END)`;
  try {
    const due: WorkflowRun[] = [];
    let offset = 0;
    // SQL narrows the candidates; typed readers own the persisted cursor contract.
    // Read past malformed candidates so they cannot consume the bounded due slots.
    while (true) {
      const result = await pool.query<WorkflowRunRow>(
        `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE (${retryAt} IS NULL OR ${retryAt} <= $1)
         AND ((status = 'paused' AND ${metadataText(`${SOURCE_RELEASE_METADATA_KEY}.nodeId`)} IS NULL
               AND ${waitKind} IN ('time', 'event', 'quota')
               AND (${signaledAt} IS NOT NULL OR ${resumeAt} <= $1))
          OR (status = 'failed' AND ${scheduledResumeAt} <= $1 AND ${scheduledTriggeredAt} IS NULL)
          OR (${answeredGate})
          OR (${answeredAttention})
          OR (status = 'paused' AND ${metadataText(`${SOURCE_RELEASE_METADATA_KEY}.nodeId`)} IS NOT NULL
              AND COALESCE(${metadataText('isolation')}, '') <> 'container'))
       ORDER BY CASE WHEN ${dueAt} IS NULL THEN 1 ELSE 0 END, ${dueAt} ASC, id ASC
       LIMIT $2 OFFSET $3`,
        [now.toISOString(), limit, offset]
      );
      for (const row of result.rows) {
        const run = normalizeWorkflowRun(row);
        if (
          run.status !== 'paused' ||
          readSourceRelease(run.metadata) ||
          pendingWorkflowWaitDeadline(run) ||
          answeredPauseContinuation(run)
        )
          due.push(run);
      }
      if (result.rows.length < limit || due.length >= limit) return due.slice(0, limit);
      offset += result.rows.length;
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_continuation_due_list_failed');
    throw new Error(`Failed to list due workflow continuations: ${err.message}`);
  }
}

export interface WorkflowEventSignalCandidate {
  runId: string;
  wait: Extract<WorkflowWaitContext, { kind: 'event' }>;
  outputType: string;
  structuredOutput: unknown;
}

export async function listWorkflowEventSignalCandidates(
  event: string,
  now: Date
): Promise<WorkflowEventSignalCandidate[]> {
  const postgres = getDatabaseType() === 'postgresql';
  const dialect = getDialect();
  // SQLite stores JSON as TEXT, so a malformed row must read as NULL instead of failing the scan.
  const validJson = (column: string, expr: string): string =>
    postgres ? expr : `CASE WHEN json_valid(${column}) THEN ${expr} END`;
  const runJson = (path: string): string =>
    validJson('r.metadata', dialect.jsonText('r.metadata', `wait.${path}`));
  const eventJson = (path: string): string => validJson('e.data', dialect.jsonText('e.data', path));
  const structuredOutputType = postgres
    ? "CASE WHEN e.data ? 'structured_output' THEN jsonb_typeof(e.data->'structured_output') END"
    : "CASE WHEN json_valid(e.data) THEN json_type(e.data, '$.structured_output') END";

  interface CandidateRow {
    run_id: string;
    run_metadata: unknown;
    event_data: unknown;
  }

  try {
    const result = await pool.query<CandidateRow>(
      `SELECT r.id AS run_id, r.metadata AS run_metadata, e.data AS event_data
       FROM remote_agent_workflow_runs r
       JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id
       WHERE r.status = 'paused'
         AND ${runJson('kind')} = 'event'
         AND ${runJson('event')} = $1
         AND ${runJson('signaledAt')} IS NULL
         AND ${runJson('resumeAt')} > $2
         AND e.event_type = 'node_completed'
         AND ${eventJson('output_type')} IS NOT NULL
         AND ${eventJson('output_type')} <> ''
         AND ${structuredOutputType} IS NOT NULL
         AND ${structuredOutputType} <> 'null'`,
      [event, now.toISOString()]
    );

    const candidates: WorkflowEventSignalCandidate[] = [];
    for (const row of result.rows) {
      const metadata = parseJsonObject(row.run_metadata);
      const eventData = parseJsonObject(row.event_data);
      if (!metadata || !eventData) continue;

      const parsedWait = readWorkflowWaitContext(metadata.wait);
      const outputType = eventData.output_type;
      if (
        !parsedWait ||
        parsedWait.kind !== 'event' ||
        parsedWait.event !== event ||
        parsedWait.signaledAt !== undefined ||
        Date.parse(parsedWait.resumeAt) <= now.getTime() ||
        typeof outputType !== 'string' ||
        outputType === '' ||
        !Object.hasOwn(eventData, 'structured_output')
      ) {
        continue;
      }

      candidates.push({
        runId: row.run_id,
        wait: parsedWait,
        outputType,
        structuredOutput: eventData.structured_output,
      });
    }
    return candidates;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, event }, 'db.workflow_event_signal_candidates_list_failed');
    throw new Error(`Failed to list workflow event signal candidates: ${err.message}`);
  }
}

/** Back off a continuation that could not acquire execution prerequisites. */
export type WorkflowContinuationCursor = WorkflowResumeCursor;

export async function deferWorkflowContinuation(
  id: string,
  retryAt: string,
  cursor: WorkflowContinuationCursor
): Promise<void> {
  const dialect = getDialect();
  const metadataText = (path: string): string => dialect.jsonText('metadata', path);
  const waitResumeAt = metadataText('wait.resumeAt');
  const scheduledResumeAt = metadataText('scheduled_resume.resumeAt');
  const scheduledTriggeredAt = metadataText('scheduled_resume.triggeredAt');
  const waitNodeId = metadataText('wait.nodeId');
  const scheduledAttempt = jsonIntExtract('metadata', 'scheduled_resume.attempt');
  const gatePauseId = metadataText('approval.pauseId');
  const gateNodeId = metadataText('approval.nodeId');
  const waitPauseId = metadataText('wait.pauseId');
  const releaseNodeId = metadataText(`${SOURCE_RELEASE_METADATA_KEY}.nodeId`);
  const releasedAt = metadataText(`${SOURCE_RELEASE_METADATA_KEY}.releasedAt`);
  const releaseId = metadataText(`${SOURCE_RELEASE_METADATA_KEY}.releaseId`);
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND ((status = 'paused' AND ${releaseNodeId} IS NULL AND ${waitResumeAt} = $3 AND ${waitNodeId} = $4
           AND (${waitPauseId} = $7 OR (${waitPauseId} IS NULL AND $7 IS NULL)))
         OR (status = 'failed' AND ${scheduledResumeAt} = $3
           AND ${scheduledTriggeredAt} IS NULL AND ${scheduledAttempt} = $5)
         OR (status = 'paused' AND ${releaseNodeId} IS NULL AND ${gatePauseId} = $6 AND ${gateNodeId} = $4)
         OR (status = 'paused' AND ${releaseNodeId} IS NULL AND ${waitPauseId} = $6 AND ${waitNodeId} = $4)
         OR (status = 'paused' AND ${releaseNodeId} = $4 AND ${releasedAt} = $8
           AND (${releaseId} = $9 OR (${releaseId} IS NULL AND $9 IS NULL))))`,
      [
        id,
        JSON.stringify({ continuation_retry_at: retryAt }),
        cursor.kind === 'wait' || cursor.kind === 'quota' ? cursor.resumeAt : null,
        cursor.kind === 'quota' ? null : cursor.nodeId,
        cursor.kind === 'quota' ? cursor.attempt : null,
        cursor.kind === 'answered' ? cursor.pauseId : null,
        cursor.kind === 'wait' ? (cursor.pauseId ?? null) : null,
        cursor.kind === 'source' ? cursor.releasedAt : null,
        cursor.kind === 'source' ? (cursor.releaseId ?? null) : null,
      ]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_continuation_defer_failed');
    throw new Error(`Failed to defer workflow continuation: ${err.message}`);
  }
}

/** Atomically add one answer to an open attention wait (see `IWorkflowStore.answerAttentionWait`). */
export async function answerAttentionWait(
  id: string,
  write: AttentionAnswerWrite
): Promise<{ answered: boolean }> {
  try {
    return await getDatabase().withTransaction(async query => {
      const row = await lockedRunRow(query, id);
      const answered =
        row &&
        answeredAttentionWait(
          { status: row.status, metadata: normalizeMetadata(row.metadata) },
          write
        );
      if (!answered) return { answered: false };
      await writeWaitContext(query, id, answered);
      await insertWorkflowEvent(query, waitAnsweredEvent(id, answered));
      return { answered: true };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_attention_answer_failed');
    throw new Error(`Failed to answer attention wait: ${err.message}`);
  }
}

/** Atomically apply one label write to an open attention wait (see `IWorkflowStore.labelAttentionWait`). */
export async function labelAttentionWait(
  id: string,
  write: AttentionLabelWrite
): Promise<{ labeled: true; wait: WorkflowAttentionWaitContext } | { labeled: false }> {
  try {
    return await getDatabase().withTransaction(async query => {
      const row = await lockedRunRow(query, id);
      const labeled =
        row &&
        labeledAttentionWait(
          { status: row.status, metadata: normalizeMetadata(row.metadata) },
          write
        );
      if (!labeled) return { labeled: false } as const;
      await writeWaitContext(query, id, labeled);
      await insertWorkflowEvent(query, attentionLabeledEvent(id, labeled, write));
      return { labeled: true, wait: labeled } as const;
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_attention_label_failed');
    throw new Error(`Failed to label attention wait: ${err.message}`);
  }
}

async function writeWaitContext(
  query: TransactionQuery,
  id: string,
  wait: WorkflowWaitContext
): Promise<void> {
  const writeWait =
    getDatabaseType() === 'postgresql'
      ? "jsonb_set(metadata, '{wait}', $2::jsonb, true)"
      : "json_set(metadata, '$.wait', json($2))";
  await query(`UPDATE remote_agent_workflow_runs SET metadata = ${writeWait} WHERE id = $1`, [
    id,
    JSON.stringify(workflowWaitContextSchema.parse(wait)),
  ]);
}

/** Atomically record the signal for one exact paused event wait. */
export async function signalWorkflowWait(
  id: string,
  waitContext: Extract<WorkflowWaitContext, { kind: 'event' }>,
  payload?: unknown
): Promise<{ signaled: boolean }> {
  const parsedWaitContext = workflowWaitContextSchema.parse(waitContext);
  if (parsedWaitContext.kind !== 'event') {
    throw new Error('Cannot signal a non-event workflow wait');
  }
  const dialect = getDialect();
  const eventExpr = dialect.jsonText('metadata', 'wait.event');
  const nodeExpr = dialect.jsonText('metadata', 'wait.nodeId');
  const signaledExpr = dialect.jsonText('metadata', 'wait.signaledAt');
  const resumeAtExpr = dialect.jsonText('metadata', 'wait.resumeAt');
  const pauseIdExpr = dialect.jsonText('metadata', 'wait.pauseId');
  const pauseIdParam = payload === undefined ? 6 : 7;
  const occurrenceMatch =
    parsedWaitContext.pauseId === undefined
      ? `${pauseIdExpr} IS NULL`
      : `${pauseIdExpr} = $${String(pauseIdParam)}`;
  const signaledAt = new Date().toISOString();
  const metadataWrite =
    payload === undefined
      ? getDatabaseType() === 'postgresql'
        ? "jsonb_set(metadata, '{wait,signaledAt}', to_jsonb($5::text), true)"
        : "json_set(metadata, '$.wait.signaledAt', $5)"
      : getDatabaseType() === 'postgresql'
        ? "jsonb_set(jsonb_set(metadata, '{wait,signaledAt}', to_jsonb($5::text), true), '{wait,payload}', $6::jsonb, true)"
        : "json_set(metadata, '$.wait.signaledAt', $5, '$.wait.payload', json($6))";
  try {
    return await getDatabase().withTransaction(async query => {
      const result = await query(
        `UPDATE remote_agent_workflow_runs
         SET metadata = ${metadataWrite}
         WHERE id = $1 AND status = 'paused' AND ${eventExpr} = $2
           AND ${nodeExpr} = $3 AND ${resumeAtExpr} = $4
           AND ${occurrenceMatch}
           AND ${signaledExpr} IS NULL AND ${resumeAtExpr} > $5`,
        payload === undefined
          ? [
              id,
              parsedWaitContext.event,
              parsedWaitContext.nodeId,
              parsedWaitContext.resumeAt,
              signaledAt,
              ...(parsedWaitContext.pauseId === undefined ? [] : [parsedWaitContext.pauseId]),
            ]
          : [
              id,
              parsedWaitContext.event,
              parsedWaitContext.nodeId,
              parsedWaitContext.resumeAt,
              signaledAt,
              JSON.stringify(payload),
              ...(parsedWaitContext.pauseId === undefined ? [] : [parsedWaitContext.pauseId]),
            ]
      );
      const signaled = (result.rowCount ?? 0) > 0;
      if (signaled) {
        await insertWorkflowEvent(query, {
          workflow_run_id: id,
          event_type: 'wait_signaled',
          step_name: workflowWaitStepName(parsedWaitContext),
          data: {
            event: parsedWaitContext.event,
            ...(payload !== undefined ? { payload } : {}),
          },
        });
      }
      return { signaled };
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowRunId: id, event: parsedWaitContext.event },
      'db.workflow_wait_signal_failed'
    );
    throw new Error(`Failed to signal workflow wait: ${err.message}`);
  }
}
