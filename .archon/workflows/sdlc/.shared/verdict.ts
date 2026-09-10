/**
 * The two vocabularies the delivery tail routes on, declared once for the pack.
 *
 * Both were re-enumerated at every consumer before this module existed: the
 * red-cause vocabulary six times across two packages, the review verdict twice
 * inside one. A cause one gate accepted and another refused would strand an
 * iteration between them, and the pack carried a comment ordering the reader to
 * keep two of the copies in step by hand.
 *
 * The two workflow schemas that let an agent declare a cause — implement's and
 * validate's `red_cause` enum — cannot import from here: they are JSON Schema
 * inside YAML. A conformance test asserts they carry exactly the vocabulary below,
 * so the owner is still one place and drift fails the suite rather than a run.
 */

/**
 * Red a gate may pass on, because the change cannot have caused it.
 *
 * An inherited base break or a parallel process holding a database this run needed
 * is not evidence about the change. The pull request's own CI still stands as the
 * gate, and the delivery tail pauses for explicit operator action rather than
 * flipping such a run ready.
 */
export const PASSES_RED = ['inherited', 'environment'] as const;

/** Every cause a declaring node may name for red. */
export const RED_CAUSES = ['introduced', ...PASSES_RED] as const;

export type RedCause = (typeof RED_CAUSES)[number];

/**
 * What a declaring node's `red_cause` field can hold.
 *
 * The empty string is how a green turn says it has no red to explain: OpenAI strict
 * mode rejects a schema whose `required` omits a declared property, so the absent
 * form has to live inside the type rather than in what `required` leaves out.
 */
export type DeclaredRedCause = RedCause | '';

const DECLARED_RED_CAUSES: readonly DeclaredRedCause[] = [...RED_CAUSES, ''];

/** The declared cause, or `undefined` when the text is not one this pack routes on. */
export function parseDeclaredRedCause(raw: string): DeclaredRedCause | undefined {
  return DECLARED_RED_CAUSES.find(cause => cause === raw.trim());
}

/** Whether a gate may proceed on red declared this way. */
export function passesRed(cause: DeclaredRedCause): cause is (typeof PASSES_RED)[number] {
  return (PASSES_RED as readonly string[]).includes(cause);
}

/** What delivery may do about a review's verdict. */
export type ReviewAction = 'none' | 'correct' | 'replan';

export interface ReviewVerdict {
  readonly ready: boolean;
  readonly action: ReviewAction;
}

/**
 * The authored verdict, or `undefined` when the two fields contradict each other.
 *
 * Both fields are individually schema-valid at the review node; only the pair says
 * whether the verdict is usable. Ready work has nothing to do about it, and work
 * that is not ready must name which of the two remedies it needs.
 */
export function parseReviewVerdict(ready: string, action: string): ReviewVerdict | undefined {
  if (ready === 'true' && action === 'none') return { ready: true, action: 'none' };
  if (ready === 'false' && (action === 'correct' || action === 'replan')) {
    return { ready: false, action };
  }
  return undefined;
}

/**
 * The refusal every consumer of `parseReviewVerdict` reports, worded once.
 *
 * `subject` names which verdict the caller was reading, because the same
 * contradiction means something different at the initial review and inside the
 * late-CI pass.
 */
export function invalidVerdictMessage(
  subject: 'review verdict' | 'late-CI review verdict',
  ready: string,
  action: string
): string {
  return (
    `invalid ${subject}: expected ready=true/action=none or ` +
    `ready=false/action=correct|replan, got ready=${quote(ready)} action=${quote(action)}`
  );
}

/** The refusal every consumer of `parseDeclaredRedCause` reports, worded once. */
export function invalidRedCauseMessage(raw: string): string {
  return `invalid late-CI red cause: ${quote(raw.trim())}`;
}

/** The value quoted the way these messages have always shown it. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
