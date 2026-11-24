/**
 * What the ask card draws, decided apart from drawing it: the words an option reads as, the
 * order its tiles take, whether an answer would be accepted, and how a project's asks group
 * under their items. The card draws an answer; the ask and its owners define one (DESIGN.md,
 * Visual standard rule 9), so every rule here mirrors its owner rather than inventing one.
 */
import type { AttentionQueueItem } from '../skills/runs';
import type { NeedsYouItem } from './needs-you';

/**
 * What the card needs of an attention wait, from the queue's shape: a run's attention is
 * assignable to it (its options only lack the optional `cost`), so both callers share it.
 */
export type AttentionWait = Pick<
  Extract<AttentionQueueItem, { kind: 'attention' }>,
  'form' | 'options' | 'other' | 'recommendation'
>;
type WaitOption = AttentionWait['options'][number];

/** An answer as the answer routes take it. */
interface AnswerDraft {
  choose: readonly string[];
  text: string;
}

/** An id in sentence case, its hyphens and underscores read as spaces: "send-back-once-more" reads "Send back once more". */
export function humaniseId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Whether `optionId` is the reserved option of a wait declared with `other: true`. The engine
 * appends it after the declared options, so the flag names it by position, not by id: read it
 * from the wait's own order, never from the recommended-first display order.
 */
export function isOtherOption(
  wait: Pick<AttentionWait, 'other' | 'options'>,
  optionId: string
): boolean {
  return wait.other === true && optionId === wait.options.at(-1)?.id;
}

/**
 * The words an option reads as (rule 8): "Something else" for the reserved `other` option,
 * else its label, else its id humanised. An option id is never shown raw.
 */
export function optionLabel(
  wait: Pick<AttentionWait, 'other' | 'options'>,
  option: Pick<WaitOption, 'id' | 'label'>
): string {
  if (isOtherOption(wait, option.id)) return 'Something else';
  return option.label ?? humaniseId(option.id);
}

/** The recommended option's words, also when its id matches no option; undefined without one. */
export function recommendedLabel(wait: AttentionWait): string | undefined {
  const id = wait.recommendation?.option;
  if (id === undefined) return undefined;
  const option = wait.options.find(candidate => candidate.id === id);
  return option === undefined ? humaniseId(id) : optionLabel(wait, option);
}

/** The recommendation's reason, after its confidence when it has one: "High confidence. Review is ready." */
export function recommendationWhy(
  recommendation: NonNullable<AttentionWait['recommendation']>
): string {
  const { confidence, why } = recommendation;
  return confidence === undefined ? why : `${humaniseId(confidence)} confidence. ${why}`;
}

/**
 * The tiles' order: the recommended option first, the rest in their declared order (the
 * engine's reserved `other` option is declared last, so it stays last). With no
 * recommendation, or one matching no option, the declared order is kept.
 */
export function tileOrder(wait: AttentionWait): WaitOption[] {
  const recommended = wait.options.find(option => option.id === wait.recommendation?.option);
  if (recommended === undefined) return [...wait.options];
  return [recommended, ...wait.options.filter(option => option !== recommended)];
}

/**
 * Why `answer` would be refused for `wait`, or undefined when it would be accepted: the rule
 * `attentionAnswerProblem` holds in `@archon/workflows` (`schemas/run-wait.ts`), which every
 * answer surface follows. `@archon/web` must not import `@archon/workflows`, so this mirrors
 * it, and `scripts/attention-answer-parity.test.ts` runs both on the same cases. A message
 * takes text only, and not blank text; approval and select take exactly one declared option;
 * multi_select one or more distinct declared options; the reserved `other` option needs text.
 */
export function answerProblem(wait: AttentionWait, answer: AnswerDraft): string | undefined {
  const form = wait.form;
  if (form === 'message') {
    if (answer.choose.length > 0) return 'takes only text';
    return answer.text.trim() === '' ? 'needs text.' : undefined;
  }
  const declared = wait.options.map(option => option.id);
  if (answer.choose.some(id => !declared.includes(id))) return 'chooses an undeclared option';
  if (form === 'multi_select') {
    if (answer.choose.length === 0) return 'needs at least one option';
    if (new Set(answer.choose).size !== answer.choose.length) return 'takes each option once';
  } else if (answer.choose.length !== 1) return 'takes exactly one option';
  const other = wait.options.at(-1)?.id;
  if (wait.other === true && other !== undefined && answer.choose.includes(other))
    return answer.text.trim() === '' ? 'needs text with Something else' : undefined;
  return undefined;
}

/**
 * The picks after choosing `optionId`: a multi_select toggles it among the others; every other
 * form holds one pick, so choosing the picked option again clears it.
 */
export function pickOption(
  wait: Pick<AttentionWait, 'form'>,
  picks: readonly string[],
  optionId: string
): string[] {
  if (picks.includes(optionId)) return picks.filter(id => id !== optionId);
  return wait.form === 'multi_select' ? [...picks, optionId] : [optionId];
}

/** Whether the picks open the textarea: an answer in words, or the reserved `other` option chosen. */
export function takesText(wait: AttentionWait, picks: readonly string[]): boolean {
  return wait.form === 'message' || picks.some(id => isOtherOption(wait, id));
}

/** The NeedsYou entries one item (or one item-less run) holds, newest ask first. */
interface AskSubjectGroup<T> {
  /** `item:<id>` for an item's asks, `run:<id>` for a wait no item holds. */
  key: string;
  /** The group's newest ask, which names it. */
  first: T;
  asks: T[];
}

type Groupable = Pick<AttentionQueueItem, 'ref' | 'item' | 'pausedAt'> & {
  run?: { id: string };
};

function subjectKey(entry: Groupable): string {
  if (entry.item !== undefined) return `item:${entry.item.id}`;
  return `run:${entry.run?.id ?? entry.ref}`;
}

/**
 * Asks grouped under their item, in the order of `entries` (the queue's newest-first order):
 * a group sits where its newest ask would, and within a group the asks keep that order. A
 * wait no item holds is grouped by its run.
 */
export function groupBySubject<T extends Groupable>(entries: readonly T[]): AskSubjectGroup<T>[] {
  const groups = new Map<string, AskSubjectGroup<T>>();
  for (const entry of entries) {
    const key = subjectKey(entry);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, first: entry, asks: [entry] });
    else group.asks.push(entry);
  }
  return [...groups.values()];
}

/**
 * A workflow's name without its pack: the engine names a pack's workflow `<pack>:<name>`
 * ("Wirasm/archon-software-factory:deliver" reads "deliver"); any other name is kept.
 */
export function shortWorkflow(workflow: string): string {
  const colon = workflow.lastIndexOf(':');
  return colon < 0 ? workflow : workflow.slice(colon + 1);
}

/**
 * What an ask asks, as its heading: the wait's own message, or what happened to a paused run
 * the console cannot answer. The ask card, the board card's face and the board's stop line
 * all read this, so an ask reads the same wherever it shows.
 */
export function askQuestion(ask: NeedsYouItem): string {
  switch (ask.kind) {
    case 'unreadable':
      return 'This paused run could not be read';
    case 'owner_lost':
      return 'A run lost its owner';
    case 'overdue_wait':
      return 'A stage is still waiting past its deadline';
    default:
      return ask.message;
  }
}

/** The one choice a short form of an ask shows (the compact card, a board card's face). */
export interface AskTile {
  label: string;
  /** The recommendation's reason, else what the option does; for a hover title. */
  detail?: string;
  recommended: boolean;
}

/** The recommended option, else the first; words for an ask that has no option to show. */
export function askTile(ask: NeedsYouItem): AskTile {
  switch (ask.kind) {
    case 'attention': {
      const first = tileOrder(ask)[0];
      if (ask.form === 'message' || first === undefined)
        return { label: 'Answer in words', recommended: false };
      const recommended = first.id === ask.recommendation?.option;
      const detail =
        recommended && ask.recommendation !== undefined
          ? recommendationWhy(ask.recommendation)
          : first.does;
      return {
        label: optionLabel(ask, first),
        ...(detail === undefined ? {} : { detail }),
        recommended,
      };
    }
    case 'awaiting_response':
      return { label: 'A gate waits for your decision', recommended: false };
    case 'owner_lost':
    case 'unreadable':
      return { label: 'Resume or abandon it on the run', recommended: false };
    case 'overdue_wait':
      return { label: 'Look at it on the run', recommended: false };
  }
}
