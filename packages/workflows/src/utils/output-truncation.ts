/**
 * The marker appended to node output that was clipped before persistence.
 *
 * Two sides must agree on this string, so it lives in one place rather than
 * being written by one and pattern-matched by the other:
 *   - `formatPersistedBashOutput` (dag-executor) WRITES it when successful bash
 *     stdout exceeds the persisted-event byte cap.
 *   - `resolveNodeOutputField` (output-ref) RECOGNISES it so a resumed run can
 *     explain why an output it cannot parse was nonetheless emitted correctly.
 *
 * That second case is not hypothetical. `output_format` is declared on
 * `dagNodeBaseSchema`, so a bash node may carry one; the fresh path holds the
 * full stdout in memory and parses fine, while a resumed run rehydrates the
 * clipped text and cannot. Without this marker the failure reads "output is not
 * a JSON object — emit JSON containing 'x'", which sends the author to fix a
 * producer that was already correct.
 */

/** Build the marker for an output clipped from `originalBytes` UTF-8 bytes. */
export function buildTruncationMarker(originalBytes: number): string {
  return `\n\n… [truncated; original output was ${String(originalBytes)} bytes]`;
}

/**
 * Matches {@link buildTruncationMarker} at end-of-string. Anchored so arbitrary
 * node output that merely quotes the phrase is not mistaken for a clipped one.
 */
const TRUNCATION_MARKER_PATTERN = /\n\n… \[truncated; original output was \d+ bytes\]$/;

/** Whether `output` ends with the persistence truncation marker. */
export function hasTruncationMarker(output: string): boolean {
  return TRUNCATION_MARKER_PATTERN.test(output.trimEnd());
}
