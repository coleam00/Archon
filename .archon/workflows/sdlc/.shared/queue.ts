/**
 * What every pack queue after intake shares: the attention item a queue raises when a
 * decision is not clear, and the decision entries it records on an item.
 *
 * An agent decides each item. A clear case acts on its own; anything unclear becomes
 * one attention item that a person can decide without opening the run. The answer is
 * one of the choices the agent declared, or the wait's own `other` (`other: true`): the
 * person's text is then the ruling, and the queue does one fixed effect with it. Each
 * choice rides on its wait option as the option's `value`, so the answer returns the
 * chosen choice itself and the queue acts on it, never on the answer's prose. A
 * choice's effect vocabulary belongs to the queue that declares it.
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

// Decisions and their prose are capped so a queue's record keeps the work item well under
// the state store's 64 KiB limit. `archon state log` keeps every revision.
const KEPT_DECISIONS = 20;
const KEPT_TEXT = 1500;

export function clipped(text: string): string {
  return text.length <= KEPT_TEXT ? text : `${text.slice(0, KEPT_TEXT)}…`;
}

/** A queue's decisions with one more recorded: its reason clipped, the oldest dropped past the cap. */
export function withDecision<Entry extends DecisionEntry>(prior: readonly Entry[] | undefined, entry: Entry): Entry[] {
  return [...(prior ?? []), { ...entry, reason: clipped(entry.reason) }].slice(-KEPT_DECISIONS);
}

/** The wait's reserved free-text option, which no declared choice may use as its id. */
const OTHER = 'other';

/**
 * The choice an answer chose. An `other` answer returns no choice: its text is the
 * ruling, written into the issue body, and the queue does `effect` with it.
 */
export function answeredChoice<Effect extends string>(value: Choice<Effect> | null, effect: Effect): Choice<Effect> {
  return value ?? { id: OTHER, label: 'Something else', does: 'Do what the answer text says.', effect, ruling: '' };
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
 * `other` says what the queue does with an `other` answer's text.
 */
export function attentionWait<Effect extends string>(
  title: string,
  attention: Attention<Effect>,
  other = ''
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
      ...(other === '' ? [] : [`**If you answer \`other\`.** ${other}`, '']),
      '**Evidence links.**',
      ...attention.links.map(link => `- ${link}`),
    ].join('\n'),
    // The wait owns `other`, and refuses a declared option of that id.
    options: attention.choices.filter(choice => choice.id !== OTHER).map(choice => ({
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
