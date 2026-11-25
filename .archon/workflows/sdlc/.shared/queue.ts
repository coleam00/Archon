/**
 * What every pack queue after intake shares: the decision entries it records on an
 * item, the notice that says what it did, and the heading a maintainer's ruling is
 * written under in the issue body.
 */

import { notice } from 'archon:script';

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
