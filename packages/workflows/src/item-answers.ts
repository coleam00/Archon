/**
 * The answers an item read lists, built from what the store recorded: an answer to a
 * question or gate from its run event, and the answers and settlements of the item's asks.
 * `itemAnswerSchema` in `item-read.ts` owns the shape.
 */
import { z } from 'zod';
import { askItemRef } from './attention-item-refs';
import type { ItemAnswer } from './item-read';
import { chosenAskOption, type StoredItemAsk } from './schemas/item-ask';
import { recordSurfaceSchema } from './schemas/record-surface';
import {
  attentionAnswererSchema,
  attentionAnsweringRunSchema,
  attentionAnswerSchema,
} from './schemas/workflow-run';
import type { WorkflowEventRow } from './schemas/workflow-event';

function field<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A recorded answer to a question or a gate, from its event row. */
export function itemAnswer(row: WorkflowEventRow): ItemAnswer {
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

/** An answered or withdrawn ask as an entry of the item's answers; null while it is open or once replaced. */
function askAnswer({ id, runId, ask, closed }: StoredItemAsk): ItemAnswer | null {
  if (closed === null || closed.as === 'replaced') return null;
  const answer = closed.as === 'answered' ? closed.answer : null;
  return {
    kind: 'ask',
    runId,
    node: null,
    occurrence: null,
    at: closed.act.at,
    via: closed.act.via,
    ref: askItemRef(id),
    question: ask.question,
    answer,
    chosen: answer === null ? null : (chosenAskOption(ask, answer) ?? null),
    withdrawn: answer === null,
    by: closed.act.by,
    fromRun: closed.act.fromRun,
  };
}

/**
 * The answers and settled sets the item's asks hold: one entry per answered or withdrawn
 * ask, and one `asks_settled` per set whose asks all closed that way and all read, at its
 * last close. `unreadable` names the sets with a row that could not be read: any of those
 * rows may be an open ask, so the read cannot say the set settled.
 */
export function askAnswers(
  asks: readonly StoredItemAsk[],
  unreadable: ReadonlySet<string>
): ItemAnswer[] {
  const sets = new Map<string, StoredItemAsk[]>();
  for (const ask of asks) sets.set(ask.runId, [...(sets.get(ask.runId) ?? []), ask]);
  return [...sets].flatMap(([runId, set]) => {
    const closes = set.map(askAnswer).filter(answer => answer?.kind === 'ask');
    const [first] = closes;
    if (first === undefined || closes.length < set.length || unreadable.has(runId)) return closes;
    const answered = closes.filter(close => !close.withdrawn).length;
    const settled: ItemAnswer = {
      kind: 'asks_settled',
      runId,
      node: null,
      occurrence: null,
      at: closes.reduce(
        (last, close) => (Date.parse(close.at) > Date.parse(last) ? close.at : last),
        first.at
      ),
      via: null,
      answered,
      withdrawn: closes.length - answered,
    };
    return [...closes, settled];
  });
}
