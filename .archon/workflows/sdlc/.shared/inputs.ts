/**
 * Reading what the engine binds to a script, beyond the text `input()` returns.
 *
 * A `with:` binding is always text: a skipped producer bound with `if_skipped: null`
 * arrives as `null`, and a field its producer declared null arrives as empty text.
 * What a value means belongs to the script that knows what it is for.
 */

/** A bound JSON value that may be null: empty text and a literal `null` both read as null. */
export function nullableJson(bound: string | undefined): unknown {
  const raw = (bound ?? '').trim();
  return raw === '' ? null : (JSON.parse(raw) as unknown);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One typed output of this run, as a `with: { <name>: { outputs: <output_type> } }`
 * binding delivers it: the node that produced it, its loop iterations (outermost
 * first, empty at top level), when the engine recorded it, and its certified value.
 */
export interface TypedOutput<T> {
  readonly node: string;
  readonly loop: readonly { readonly group: string; readonly iteration: number }[];
  readonly at: string;
  readonly value: T;
}

/** What a script says when a binding declared `if_unreadable: null` and took it. */
export const UNREADABLE_OUTPUTS = "a typed-output record of this run could not be read; the run's log names it";

/**
 * A bound typed-outputs value: every output of the type, oldest first, and complete.
 * Null when a record could not be read and the binding declared `if_unreadable: null`;
 * without that declaration the engine fails the node instead.
 */
export function typedOutputs<T>(bound: string): readonly TypedOutput<T>[] | null {
  return JSON.parse(bound) as TypedOutput<T>[] | null;
}

/** The value as an object, or undefined for anything else. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
