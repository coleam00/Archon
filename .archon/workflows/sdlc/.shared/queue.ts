/**
 * What every pack queue after intake shares: the ask a queue raises when a decision is
 * not clear, and the decision entries it records on an item.
 *
 * An agent decides each item. A clear case acts on its own; anything unclear becomes
 * one ask that a person can decide without opening the run. The agent writes the wait's
 * own fields (the question, the options and the recommendation), and the queue's script
 * hands them to the wait unchanged. The answer is one of the options the agent declared,
 * or the wait's own `other` (`other: true`): the person's text is then the ruling, and
 * the queue does one fixed effect with it. The queue acts on the chosen option's
 * `value`, never on the answer's prose. An effect vocabulary belongs to the queue that
 * declares it.
 */

import { notice } from 'archon:script';

/** One answer the person can give, as the wait takes it. */
export interface AskOption<Effect extends string> {
  /** The id the answer carries: kebab-case, unique within the ask. */
  readonly id: string;
  readonly label: string;
  /** What choosing it does, in plain words. */
  readonly does: string;
  readonly value: {
    readonly effect: Effect;
    /**
     * The ruling written into the issue body as a dated "Current scope" section when
     * this is chosen, so the next run and review read it as the contract. Empty writes
     * no section.
     */
    readonly ruling: string;
  };
}

/** The wait's fields, as the deciding agent wrote them. */
export interface Ask<Effect extends string> {
  /** Everything the person reads; its first sentence names the item and the decision. */
  readonly question: string;
  readonly options: readonly AskOption<Effect>[];
  readonly recommendation: { readonly option: string; readonly why: string; readonly confidence: string };
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

/** The wait's reserved free-text option. */
const OTHER = 'other';

/**
 * The option an answer chose, by the answer's `decision`. An `other` answer chose none:
 * its text is the ruling, written into the issue body, and the queue does `effect` with it.
 */
export function answeredChoice<Effect extends string>(ask: Ask<Effect>, decision: string, effect: Effect): AskOption<Effect> {
  const option = ask.options.find(candidate => candidate.id === decision);
  if (option !== undefined) return option;
  if (decision !== OTHER) throw new Error(`the answer "${decision}" is none of the asked options`);
  return { id: OTHER, label: 'Something else', does: 'Do what the answer text says.', value: { effect, ruling: '' } };
}

/**
 * Say on the attention stream what a queue just did, after the write that did it. The
 * text is cut to the engine's one line of 300 characters. A notice the host refuses is
 * reported on stderr and never fails the run: the write it reports already holds.
 */
export function announce(text: string, labels: Readonly<Record<string, string>>): void {
  const line = text.replace(/\s+/g, ' ').trim();
  try {
    notice(line.length <= 300 ? line : `${line.slice(0, 299)}…`, labels);
  } catch (error) {
    console.error(`notice not emitted (${error instanceof Error ? error.message : String(error)}): ${line}`);
  }
}

/** The heading of the dated section a ruling is written under. */
export function rulingHeading(at: string, about: string): string {
  return `Current scope (maintainer ruling on ${about}, ${at.slice(0, 10)})`;
}
