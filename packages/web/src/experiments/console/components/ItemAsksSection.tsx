import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { AttentionAnswerForm } from './AttentionAnswerPanel';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { ItemAsk, RunsAttention } from '../primitives/run';

/** An ask this console answered in this browser session, kept to show it as answered. */
export interface AnsweredAsk {
  ask: ItemAsk;
  choose: string[];
  text: string | undefined;
}

/** The item an ask belongs to; an ask whose item is gone stands on its own. */
export function askGroupKey(ask: ItemAsk): string {
  return ask.item?.id ?? ask.ref;
}

/** What the pending-input banner shows of asks left on items, and how it changes it. */
export interface ItemAsks {
  /** Open asks no run holds, in scope, in the order the list returns them. */
  asks: ItemAsk[];
  /** Asks answered here this session, in scope, kept until their item is dismissed. */
  answered: AnsweredAsk[];
  answerRefusals: RunsAttention['answerRefusals'];
  /** Every item the list holds open, by a run or an ask. */
  itemIds: RunsAttention['itemIds'];
  onAnswered: (record: AnsweredAsk) => void;
  onDismissItem: (groupKey: string) => void;
}

/** Nothing left on any item. */
export const NO_ITEM_ASKS: ItemAsks = {
  asks: [],
  answered: [],
  answerRefusals: {},
  itemIds: new Set(),
  onAnswered: () => undefined,
  onDismissItem: () => undefined,
};

interface AskGroup {
  key: string;
  first: ItemAsk;
  open: ItemAsk[];
  answered: AnsweredAsk[];
}

function groupAsks(asks: ItemAsk[], answered: AnsweredAsk[]): AskGroup[] {
  const groups = new Map<string, AskGroup>();
  const groupOf = (ask: ItemAsk): AskGroup => {
    const key = askGroupKey(ask);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, first: ask, open: [], answered: [] };
      groups.set(key, group);
    }
    return group;
  };
  const answeredRefs = new Set(answered.map(record => record.ask.ref));
  for (const ask of asks) if (!answeredRefs.has(ask.ref)) groupOf(ask).open.push(ask);
  for (const record of answered) groupOf(record.ask).answered.push(record);
  return [...groups.values()];
}

/**
 * Asks completed runs left on their items, grouped by item. They have no run card, so
 * they sit in the pending-input banner beside the paused runs. An answer goes through the
 * answer-by-ref operation; who may answer is the server's call, carried in `answerRefusals`.
 */
export function ItemAsksSection({
  asks,
  answered,
  answerRefusals,
  itemIds,
  showProject,
  onAnswered,
  onDismissItem,
}: ItemAsks & { showProject: boolean }): ReactElement | null {
  const groups = groupAsks(asks, answered);
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map(group => {
        const { item, project } = group.first;
        const waits = group.open.length > 0 || (item !== undefined && itemIds.has(item.id));
        return (
          <article
            key={group.key}
            data-item-asks={group.key}
            className="shrink-0 rounded border border-warning/40 bg-surface py-3 pl-4 pr-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-console-10 font-semibold uppercase tracking-console-label text-warning">
                Item
              </span>
              <span className="font-mono text-sm text-text-primary">
                {item?.key ?? 'Item not found'}
              </span>
              {showProject && project !== null ? (
                <span className="truncate text-console-11 text-text-secondary">
                  · {project.name}
                </span>
              ) : null}
            </div>
            {group.open.map(ask => (
              <OpenAsk
                key={ask.ref}
                ask={ask}
                refusal={answerRefusals[ask.ref]}
                onAnswered={onAnswered}
              />
            ))}
            {group.answered.map(record => (
              <AnsweredAskLine key={record.ask.ref} record={record} />
            ))}
            {waits ? null : (
              <div className="mt-3 flex items-center gap-3 text-console-12 text-text-secondary">
                <span>This item no longer waits on anyone.</span>
                <button
                  type="button"
                  onClick={() => {
                    onDismissItem(group.key);
                  }}
                  className="rounded border border-border px-2 py-0.5 text-console-11 text-text-tertiary hover:border-border-bright hover:bg-surface-hover hover:text-text-primary"
                >
                  Dismiss
                </button>
              </div>
            )}
          </article>
        );
      })}
    </>
  );
}

function AskedIn({ ask }: { ask: ItemAsk }): ReactElement | null {
  if (ask.askedIn === undefined) return null;
  return (
    <p className="mt-1 text-console-11 text-text-tertiary">
      Asked by{' '}
      <Link className="underline" to={`/console/r/${ask.askedIn.runId}`}>
        {ask.askedIn.workflow}
      </Link>
    </p>
  );
}

function OpenAsk({
  ask,
  refusal,
  onAnswered,
}: {
  ask: ItemAsk;
  refusal: string | undefined;
  onAnswered: (record: AnsweredAsk) => void;
}): ReactElement {
  const submit = async (choose: string[], text: string | undefined): Promise<void> => {
    await skill.answerAttentionItem(ask.ref, choose, text);
    onAnswered({ ask, choose, text });
    invalidate(K.runsAttention);
  };
  return (
    <div data-ask-ref={ask.ref} className="mt-3">
      <p className="whitespace-pre-wrap text-sm text-text-primary">{ask.message}</p>
      {ask.context !== undefined ? (
        <p className="mt-1 whitespace-pre-wrap text-console-12 text-text-secondary">
          {ask.context}
        </p>
      ) : null}
      <AskedIn ask={ask} />
      {ask.recommendation === undefined ? (
        <p className="mt-1 text-console-12 text-text-primary">
          No recommendation. Choose an option.
        </p>
      ) : null}
      <AttentionAnswerForm fields={ask} submit={submit} refusal={refusal} />
    </div>
  );
}

function AnsweredAskLine({ record }: { record: AnsweredAsk }): ReactElement {
  const { ask, choose, text } = record;
  const chosen = choose
    .map(id => ask.options.find(option => option.id === id)?.label ?? id)
    .join(', ');
  return (
    <div data-ask-ref={ask.ref} className="mt-3">
      <p className="whitespace-pre-wrap text-sm text-text-secondary">{ask.message}</p>
      <p className="mt-1 text-console-12 text-success">
        Answered: {[chosen, text].filter(part => part !== undefined && part !== '').join(': ')}
      </p>
    </div>
  );
}
