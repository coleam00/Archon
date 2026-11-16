/**
 * Answering an attention queue item by its ref: the one operation a surface that lists
 * items answers through. It reads what the ref names now and does what that item needs.
 * For an item a paused run holds, that is the run's own answer operation, held to the
 * run's own permission rule. For an ask a completed run left, it is the ask's answer,
 * held to the rule of the run that left it; an ask can also be withdrawn.
 */
import {
  askIdOfRef,
  askQueueItem,
  isHeldByRun,
  readAttentionQueueItemByRef,
  type AttentionQueueItem,
  type AttentionQueueItemWithoutRun,
  type AttentionQueueSource,
  type RunAttentionQueueItem,
} from '@archon/workflows/attention-queue';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import {
  attentionAnswerProblem,
  continuablePause,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import { itemAct } from './item-rulings';
import { RunActionForbiddenError, type RunActor } from './run-authorization';
import {
  expectedGateForOccurrence,
  type AttentionAnswerRequest,
  type WorkflowOperations,
} from './workflow-operations';

export interface AttentionItemDeps {
  /** The queue every surface lists through, and the store an ask is answered in. */
  queue: AttentionQueueSource & {
    store: AttentionQueueSource['store'] &
      Pick<IWorkflowStore, 'getItemAsk' | 'answerItemAsk' | 'withdrawItemAsk'>;
  };
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
  /**
   * A gate takes one of its decisions and has no recommendation to accept; an answered ask
   * keeps its answer, so a different one is refused.
   */
  | {
      kind: 'refused';
      reason: 'gate_has_no_recommendation' | 'gate_takes_one_decision' | 'already_answered';
    }
  /** The ask already has this answer: nothing changed. */
  | { kind: 'unchanged'; item: AttentionQueueItemWithoutRun }
  /** An ask was answered; `settled` when it was the last open ask of its run's set. */
  | { kind: 'ask_answered'; item: AttentionQueueItemWithoutRun; settled: boolean }
  | {
      kind: 'answered';
      item: Answerable;
      /** The gate was rejected with no rework path, so its run is cancelled. */
      cancelled: boolean;
      /** True when a continuation host continues the run from this answer by itself. */
      continues: boolean;
    };

/**
 * The run whose permission decides who may answer `item`, when `actor` has it. An item's
 * permission is its run's: whoever started the run, or an admin. For an ask that is the
 * run that left it; once that run is deleted, nobody may answer the ask by this rule.
 */
async function answerableRun(
  deps: AttentionItemDeps,
  item: AttentionQueueItem,
  actor: RunActor
): Promise<WorkflowRun | null> {
  const runId = isHeldByRun(item)
    ? item.run.id
    : item.kind === 'attention'
      ? item.askedIn?.runId
      : undefined;
  if (runId === undefined) return null;
  const run = await deps.queue.store.getWorkflowRun(runId);
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
  const askId = askIdOfRef(ref);
  if (askId !== undefined) return answerAsk(deps, askId, answer, actor, via);
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

/** An answer that does not fit the ask's form: an undeclared option, or `other` without text. */
export class AskAnswerInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskAnswerInvalidError';
  }
}

/** The ask `askId` names and its queue item, when `actor` may answer it. */
async function answerableAsk(
  deps: AttentionItemDeps,
  askId: string,
  actor: RunActor
): Promise<{ ask: StoredItemAsk; item: AttentionQueueItemWithoutRun } | undefined> {
  // Read by id, not from the open list, so a repeated answer finds the answered ask.
  const ask = await deps.queue.store.getItemAsk(askId);
  if (ask === null) return undefined;
  const item = await askQueueItem(deps.queue.store, ask);
  return (await answerableRun(deps, item, actor)) === null ? undefined : { ask, item };
}

async function answerAsk(
  deps: AttentionItemDeps,
  askId: string,
  request: AttentionAnswerRequest,
  actor: RunActor,
  via: RecordSurface
): Promise<AttentionItemAnswerResult> {
  const found = await answerableAsk(deps, askId, actor);
  if (found === undefined) return { kind: 'unknown' };
  const { ask, item } = found;
  const text = request.text ?? '';
  const choose = 'recommended' in request ? [ask.ask.recommendation.option] : request.choose;
  const problem = attentionAnswerProblem(item, { choose, text });
  if (problem !== undefined) throw new AskAnswerInvalidError(`Ask ${item.ref} ${problem}`);
  const [decision = ''] = choose;
  const result = await deps.queue.store.answerItemAsk({
    askId,
    answer: { decision, text },
    ...(await itemAct(deps.queue.store, actor, via)),
  });
  switch (result.kind) {
    case 'not_found':
      return { kind: 'unknown' };
    case 'closed':
      return { kind: 'ask_answered', item, settled: result.settled };
    case 'unchanged':
      return { kind: 'unchanged', item };
    case 'refused':
      return result.ask.closed?.as === 'answered'
        ? { kind: 'refused', reason: 'already_answered' }
        : { kind: 'none' };
  }
}

/** What became of withdrawing the item a ref names. */
export type AttentionItemWithdrawResult =
  /** Nothing the actor may withdraw has this ref. */
  | { kind: 'unknown' }
  /** Only an ask a completed run left can be withdrawn; a paused run's item is answered. */
  | { kind: 'not_an_ask' }
  /** The ask was answered or replaced; that close stands. */
  | { kind: 'refused'; closedAs: 'answered' | 'replaced' }
  /** The ask was already withdrawn: nothing changed. */
  | { kind: 'unchanged'; item: AttentionQueueItemWithoutRun }
  /** `settled` when it was the last open ask of its run's set. */
  | { kind: 'withdrawn'; item: AttentionQueueItemWithoutRun; settled: boolean };

/**
 * Withdraw the ask `ref` names: it closes unanswered. Held to the rule an answer is, and
 * settles its set as an answer does.
 */
export async function withdrawAttentionItem(
  deps: AttentionItemDeps,
  ref: string,
  actor: RunActor,
  via: RecordSurface
): Promise<AttentionItemWithdrawResult> {
  const askId = askIdOfRef(ref);
  if (askId === undefined) return { kind: 'not_an_ask' };
  const found = await answerableAsk(deps, askId, actor);
  if (found === undefined) return { kind: 'unknown' };
  const result = await deps.queue.store.withdrawItemAsk({
    askId,
    ...(await itemAct(deps.queue.store, actor, via)),
  });
  switch (result.kind) {
    case 'not_found':
      return { kind: 'unknown' };
    case 'closed':
      return { kind: 'withdrawn', item: found.item, settled: result.settled };
    case 'unchanged':
      return { kind: 'unchanged', item: found.item };
    case 'refused':
      return {
        kind: 'refused',
        closedAs: result.ask.closed?.as === 'answered' ? 'answered' : 'replaced',
      };
  }
}
