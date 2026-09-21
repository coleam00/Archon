/**
 * The one judgment this pack makes about a red gate: whether the declared cause is
 * one the change cannot have introduced.
 *
 * The vocabulary itself (`introduced`, `inherited`, `environment`, or the empty
 * string for "not declared") is an enum on the producing nodes' `output_format`,
 * where the engine certifies it. Nothing here re-checks membership: a value that
 * reaches a script through a `with:` binding already passed that gate.
 */

export const PASSES_RED = ['inherited', 'environment'] as const;

/** Red that the change did not cause: the base was already red, or the environment was. */
export function passesRed(cause: string): boolean {
  return (PASSES_RED as readonly string[]).includes(cause);
}
