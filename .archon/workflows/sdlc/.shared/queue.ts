/**
 * What every pack queue after intake shares: the attention item a queue raises when a
 * decision is not clear, and the decision entries it records on an item.
 *
 * An agent decides each item. A clear case acts on its own; anything unclear becomes
 * one attention item that a person can decide without opening the run. The answer is
 * one of the choices the agent declared, or `other`, which every item offers: the
 * person's text is then the ruling, and the queue does what that choice's effect says
 * with it. Each choice rides on its wait option as the option's `value`, so the answer
 * returns the chosen choice itself and the queue acts on it, never on the answer's
 * prose. A choice's effect vocabulary belongs to the queue that declares it.
 */

/** One answer the person can give, and what the queue does when it is chosen. */
export interface Choice<Effect extends string> {
  /** The id the attention answer carries: kebab-case, unique within the item. */
  readonly id: string;
  readonly label: string;
  /** What choosing it does, in plain words. */
  readonly does: string;
  readonly effect: Effect;
  /**
   * The ruling written into the issue body as a dated "Current scope" section when
   * this is chosen, so the next run and review read it as the contract. Empty writes
   * no section.
   */
  readonly ruling: string;
}

export const CONFIDENCES = ['low', 'medium', 'high'] as const;

export interface Recommendation {
  /** The id of the recommended choice. */
  readonly choice: string;
  readonly why: string;
  readonly evidence: string;
  readonly confidence: (typeof CONFIDENCES)[number];
  readonly would_change: string;
}

export interface Attention<Effect extends string> {
  /** The item and the decision, in plain words. */
  readonly what: string;
  /** What happens if it is decided either way. */
  readonly why: string;
  readonly recommendation: Recommendation;
  readonly choices: readonly Choice<Effect>[];
  /** Whether the item waits, blocks others, or goes stale while nobody answers. */
  readonly if_unanswered: string;
  /** The pull request, the review report and the run. */
  readonly links: readonly string[];
}

/** One decision a queue recorded on an item, with the person's answer when it asked. */
export interface DecisionEntry {
  readonly at: string;
  readonly run_id: string;
  readonly decision: string;
  readonly reason: string;
  readonly links: readonly string[];
  readonly answer?: { readonly choice: string; readonly text: string; readonly at: string };
}

/**
 * Refuse an attention item a person could not answer: no choices, two choices with one
 * id, or a recommendation of a choice that was never offered. The schema the agent
 * answered already certified each field's shape. The wait refuses the same item, but
 * only when it pauses, after the queue has recorded the ask; this check runs before.
 */
export function checkAttention<Effect extends string>(attention: Attention<Effect>): void {
  const ids = attention.choices.map(choice => choice.id);
  if (ids.length === 0) throw new Error('the attention item offers no choice');
  if (new Set(ids).size !== ids.length) throw new Error('two choices share one id');
  if (!ids.includes(attention.recommendation.choice)) {
    throw new Error(`the recommended choice "${attention.recommendation.choice}" is not offered`);
  }
}

/** The choice every item offers when none of the declared ones fits. */
export const OTHER = 'other';

/**
 * The item with `other` added: the person says in the answer's text what to do instead,
 * and that text is written into the issue body as the ruling. `effect` is what the queue
 * does with it, normally its continue-the-work effect.
 */
export function withOther<Effect extends string>(
  attention: Attention<Effect>,
  effect: Effect,
  does = 'Do what the answer text says. The text is written into the issue body as the ruling, and the next round works from it.'
): Attention<Effect> {
  // The queue owns `other`: an agent-declared one is replaced, so its effect is always this one.
  return {
    ...attention,
    choices: [
      ...attention.choices.filter(choice => choice.id !== OTHER),
      {
        id: OTHER,
        label: 'Something else',
        does,
        effect,
        ruling: '',
      },
    ],
  };
}

/** What a `select` attention wait asks with: its message, its options and its recommendation. */
export interface AttentionWait<Effect extends string> {
  readonly message: string;
  /** Each choice, carried whole as the option's `value` so the answer returns it. */
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly does: string;
    readonly value: Choice<Effect>;
  }[];
  readonly recommendation: {
    readonly option: string;
    readonly why: string;
    readonly confidence: Recommendation['confidence'];
  };
}

/**
 * The wait's fields for an attention item. The engine shows the recommendation and what
 * each choice does; the message carries the rest, in the order a person reads it.
 */
export function attentionWait<Effect extends string>(
  title: string,
  attention: Attention<Effect>
): AttentionWait<Effect> {
  const { recommendation } = attention;
  return {
    message: [
      `**${title}**`,
      '',
      `**What it is.** ${attention.what}`,
      '',
      `**Why it matters.** ${attention.why}`,
      '',
      `**Evidence for the recommendation.** ${recommendation.evidence}`,
      `What would change it: ${recommendation.would_change}`,
      '',
      `**If nobody answers.** ${attention.if_unanswered}`,
      '',
      '**Evidence links.**',
      ...attention.links.map(link => `- ${link}`),
    ].join('\n'),
    options: attention.choices.map(choice => ({
      id: choice.id,
      label: choice.label,
      does: choice.does,
      value: choice,
    })),
    recommendation: {
      option: recommendation.choice,
      why: recommendation.why,
      confidence: recommendation.confidence,
    },
  };
}

/**
 * Why an answer carries no chosen choice: its wait paused before options carried their
 * choice as a value, so the answer cannot be acted on. The operator starts the stage or
 * queue run again, which asks afresh.
 */
export const PRE_VALUE_ANSWER =
  'the answer carries no chosen choice: its wait paused before options carried one. Abandon this run and start the stage or queue again; it asks the question afresh';

/** A queue's ask node fields: the wait's, or empty ones when nothing is asked. */
export function askFields<Effect extends string>(wait: AttentionWait<Effect> | null) {
  return {
    attention: wait?.message ?? '',
    options: wait?.options ?? [],
    recommendation: wait?.recommendation ?? null,
  };
}

/** The heading of the dated section a ruling is written under. */
export function rulingHeading(at: string, about: string): string {
  return `Current scope (maintainer ruling on ${about}, ${at.slice(0, 10)})`;
}
