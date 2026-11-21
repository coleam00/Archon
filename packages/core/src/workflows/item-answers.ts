/**
 * The answers a binding passes a stage: one settled set (`{answers: true}`) or every
 * answer on the item (`{item: 'answers'}`). Both build each entry here, so the two shapes
 * cannot drift apart.
 */
import type { JsonValue } from '@archon/workflows/output-ref';
import {
  isAttentionDegraded,
  type AttentionRead,
} from '@archon/workflows/schemas/attention-degraded';
import { chosenAskOption, type StoredItemAsk } from '@archon/workflows/schemas/item-ask';

/**
 * One ask of a settled set as `{answers: true}` passes it: the question, how it closed, the
 * answer and the option it chose, and who closed it, through which surface and when.
 */
export function settledAnswer(row: StoredItemAsk): Record<string, JsonValue> {
  const { closed } = row;
  // Unreachable: a replaced set can never settle, because a replaced ask cannot be closed.
  if (closed === null || closed.as === 'replaced')
    throw new Error(`Ask '${row.id}' is not answered or withdrawn in a settled set`);
  const option = closed.as === 'answered' ? chosenAskOption(row.ask, closed.answer) : undefined;
  return {
    question: row.ask.question,
    closedAs: closed.as,
    answer: closed.as === 'answered' ? closed.answer : null,
    option: option ?? null,
    by: closed.act.by,
    via: closed.act.via,
    at: closed.act.at,
  };
}

/** What `{item: 'answers'}` passes, or why it cannot be read. */
export type ItemAnswers = { entries: JsonValue[] } | { unreadable: string };

/**
 * Every answered or withdrawn ask on an item, oldest answer first, each as `settledAnswer`
 * builds it plus the workflow that asked it, so an answer that changes an earlier one is
 * read last. The sort is stable, so asks closed at the same instant keep the order given
 * (the item's: the order they were left). Open asks and replaced ones are left out: a
 * replaced ask was never answered, and the set that replaced it carries the question
 * again. One unreadable row makes the whole list unreadable, rather than passing the
 * stage a list with a decision missing.
 */
export function itemAnswers(rows: readonly AttentionRead<StoredItemAsk>[]): ItemAnswers {
  const closed: { at: number; entry: JsonValue }[] = [];
  for (const row of rows) {
    if (isAttentionDegraded(row))
      return {
        unreadable: `an ask run '${row.runId}' left on the item cannot be read by this binary`,
      };
    if (row.closed?.as !== 'answered' && row.closed?.as !== 'withdrawn') continue;
    closed.push({
      at: Date.parse(row.closed.act.at),
      entry: { ...settledAnswer(row), workflowName: row.workflowName },
    });
  }
  return { entries: closed.sort((a, b) => a.at - b.at).map(({ entry }) => entry) };
}
