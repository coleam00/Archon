/**
 * The two decisions the run form makes about declared workflow inputs (#2554).
 *
 * Kept out of the component so they are provable without a React DOM harness — the
 * console's existing convention (see `lib/recommended.ts`) is that the interesting
 * decision is a pure function and the component only renders it.
 */
import type { WorkflowInput } from '../primitives/workflow';

/**
 * Required inputs the user has not filled, in declaration order.
 *
 * Whitespace is not a value: a field holding only spaces reads as unfilled, so the
 * form cannot start a run that would immediately be refused server-side.
 */
export function missingRequiredInputs(
  declared: readonly WorkflowInput[],
  values: Readonly<Record<string, string>>
): string[] {
  return declared
    .filter(input => input.required && (values[input.name] ?? '').trim().length === 0)
    .map(input => input.name);
}

/**
 * The map to send: only inputs the user actually filled.
 *
 * An untouched optional field must be OMITTED, not sent as `''` — sending the empty
 * string would override the workflow's declared `default:` with nothing. The cost is
 * that the form cannot express a deliberate empty string; the CLI's `--input name=`
 * can, and that is the right trade for the common case.
 *
 * Values are sent verbatim (never trimmed) — leading or trailing whitespace can be
 * meaningful inside a value, even though it does not count as *filling* a field.
 */
export function collectSuppliedInputs(
  declared: readonly WorkflowInput[],
  values: Readonly<Record<string, string>>
): Record<string, string> {
  const supplied: Record<string, string> = {};
  for (const input of declared) {
    const value = values[input.name] ?? '';
    if (value.trim().length > 0) supplied[input.name] = value;
  }
  return supplied;
}
