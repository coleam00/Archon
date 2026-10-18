/**
 * The marker appended to node output that was clipped before persistence.
 *
 * Two sides must agree on this string, so it lives in one place rather than
 * being written by one and pattern-matched by the other:
 *   - `formatPersistedNodeOutput` (dag/node-output) WRITES it when successful bash or
 *     script stdout exceeds the persisted-event byte cap.
 *   - `resolveNodeOutputField` (output-ref) RECOGNISES it so a resumed run can
 *     explain why an output it cannot parse was nonetheless emitted correctly.
 *
 * That second case is not merely hypothetical anymore — it is the RARE case.
 * `output_format` is declared on `dagNodeBaseSchema`, so a bash/script node may
 * carry one; the fresh path holds the full stdout in memory and parses fine.
 * `formatPersistedNodeOutput` also spills the full bytes to the run's artifacts
 * directory when it truncates, and `foldDagResumeSnapshot` (dag-resume-snapshot.ts)
 * prefers that spill over the clipped preview when folding the store's resume snapshot (#2726) —
 * so a resumed run ordinarily sees the same full text a fresh run would have.
 * This marker is now the fallback: it only surfaces when the spill itself is
 * missing, unreadable (e.g. artifacts were removed out-of-band), or stale (its
 * byte length differs from the recorded output). Without it,
 * that failure would read "output is not a JSON object — emit JSON containing
 * 'x'", which sends the author to fix a producer that was already correct.
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
