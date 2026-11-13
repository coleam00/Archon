/**
 * Answering an attention queue item by its ref: the one operation a surface that lists
 * items answers through. It reads what the ref names now and does what that item needs.
 * For an item a paused run holds, that is the run's own answer operation, held to the
 * run's own permission rule.
 */
import {
  isHeldByRun,
  readAttentionQueueItemByRef,
  type AttentionQueueItem,
  type AttentionQueueSource,
  type RunAttentionQueueItem,
} from '@archon/workflows/attention-queue';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import { continuablePause, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { RunActionForbiddenError, type RunActor } from './run-authorization';
import {
  expectedGateForOccurrence,
  type AttentionAnswerRequest,
  type WorkflowOperations,
} from './workflow-operations';

export interface AttentionItemDeps {
  /** The queue every surface lists through. */
  queue: AttentionQueueSource;
  operations: Pick<
    WorkflowOperations,
    'answerWorkflow' | 'respondToWorkflow' | 'assertRunActionAllowed'
  >;
}

type Answerable = Extract<RunAttentionQueueItem, { kind: 'attention' | 'awaiting_response' }>;

/** What became of an answer to the item a ref names. */
export type AttentionItemAnswerResult =
  /** Nothing the actor may answer has this ref: no such item, or one they may not answer. */
  | { kind: 'unknown' }
  /** The item is no longer open. */
  | { kind: 'none' }
  /** The pause the ref named is over; its run now holds `item`. */
  | { kind: 'moved'; item: AttentionQueueItem }
  | {
      kind: 'takes_no_answer';
      item: Extract<AttentionQueueItem, { kind: 'usage_limit' | 'unreadable' }>;
    }
  /** A gate takes one of its decisions and has no recommendation to accept. */
  | { kind: 'refused'; reason: 'gate_has_no_recommendation' | 'gate_takes_one_decision' }
  | {
      kind: 'answered';
      item: Answerable;
      /** The gate was rejected with no rework path, so its run is cancelled. */
      cancelled: boolean;
      /** True when a continuation host continues the run from this answer by itself. */
      continues: boolean;
    };

/**
 * The run whose permission decides who may answer `item`, when `actor` has it. Today an
 * item's permission is its run's: whoever started the run, or an admin. An item no run
 * holds has no rule yet, so nobody may answer it.
 */
async function answerableRun(
  deps: AttentionItemDeps,
  item: AttentionQueueItem,
  actor: RunActor
): Promise<WorkflowRun | null> {
  if (!isHeldByRun(item)) return null;
  const run = await deps.queue.store.getWorkflowRun(item.run.id);
  if (run === null) return null;
  try {
    await deps.operations.assertRunActionAllowed(run, actor, 'respond');
    return run;
  } catch (error) {
    if (error instanceof RunActionForbiddenError) return null;
    throw error;
  }
}

/** True when `actor` may answer `item`, by the rule an answer is held to. */
export async function mayAnswerAttentionItem(
  deps: AttentionItemDeps,
  item: AttentionQueueItem,
  actor: RunActor
): Promise<boolean> {
  return (await answerableRun(deps, item, actor)) !== null;
}

/**
 * Answer the item `ref` names, pinned to the pause the ref was handed out at. An item the
 * actor may not answer reads as `unknown`, so a guessed ref tells them nothing about it:
 * not its question and not its current ref.
 */
export async function answerAttentionItem(
  deps: AttentionItemDeps,
  ref: string,
  answer: AttentionAnswerRequest,
  actor: RunActor,
  via: RecordSurface
): Promise<AttentionItemAnswerResult> {
  const read = await readAttentionQueueItemByRef(deps.queue, ref);
  if (read.kind === 'unknown' || read.kind === 'none') return read;
  const { item } = read;
  const holder = await answerableRun(deps, item, actor);
  if (holder === null || !isHeldByRun(item)) return { kind: 'unknown' };
  if (read.kind === 'moved') return read;
  if (item.kind === 'usage_limit' || item.kind === 'unreadable')
    return { kind: 'takes_no_answer', item };
  const { id, occurrence } = item.run;
  const origin = { via, expectedGate: expectedGateForOccurrence(holder, occurrence) };
  // Judged on the run as it was answered: a host may already have continued it afterwards.
  const continues = continuablePause(holder) !== undefined;
  if (item.kind === 'attention') {
    await deps.operations.answerWorkflow(id, answer, actor, origin);
    return { kind: 'answered', item, cancelled: false, continues };
  }
  if ('recommended' in answer) return { kind: 'refused', reason: 'gate_has_no_recommendation' };
  const [decision, ...rest] = answer.choose;
  if (decision === undefined || rest.length > 0)
    return { kind: 'refused', reason: 'gate_takes_one_decision' };
  const result = await deps.operations.respondToWorkflow(id, decision, answer.text, actor, origin);
  return {
    kind: 'answered',
    item,
    cancelled: 'cancelled' in result && result.cancelled === true,
    continues,
  };
}
