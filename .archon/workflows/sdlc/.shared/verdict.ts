/**
 * The one judgment this pack makes about a red gate: whether the declared cause is
 * one the change cannot have introduced.
 *
 * The vocabulary itself (`introduced`, `inherited`, `environment`, `unavailable`,
 * `interaction`, `incomplete`, or the empty string for "not declared") is an enum on the producing
 * nodes' `output_format`, where the engine certifies it. Nothing here re-checks
 * membership: a value that reaches a script through a `with:` binding already passed
 * that gate.
 */

export const PASSES_RED = ['inherited', 'environment', 'unavailable'] as const;

/**
 * Red that the change is not shown to cause: the base was already red, the environment
 * was, or the evidence that would attribute it (CI logs, the base's result) cannot be
 * read from this run. None of them is fixed in the change; each reaches the operator.
 */
export function passesRed(cause: string): boolean {
  return (PASSES_RED as readonly string[]).includes(cause);
}

/**
 * The refusal for a verdict declared `incomplete`: some checks never ran and none that
 * ran failed. It is not red, so it never says so — a reader sent hunting for a failure
 * that does not exist loses the real action, which is to let validation finish. Every
 * gate that reads a verdict refuses this cause with this one message.
 */
export function unfinishedValidation(stage: string, summary: string): string {
  return (
    `${stage}: validation didn't finish. Not every check ran, and none that ran ` +
    `failed.${summary === '' ? '' : ` ${summary}`} Resume the run once whatever ` +
    'stopped it is cleared, so validation can finish. An unfinished validation ' +
    'never passes this gate.'
  );
}
