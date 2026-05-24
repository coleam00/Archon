/** Maximum characters of tool output sent across the SSE boundary to the browser. */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Bound tool output to MAX_TOOL_OUTPUT_CHARS for browser transport.
 * Returns the string unchanged if within the cap.
 * Appends a human-readable marker so users know truncation occurred and that the
 * full output is still available in run history (i.e. in the database).
 *
 * Apply at SSE emit time and at message-history hydration time.
 * Do NOT apply before writing to the database — the DB is the authoritative record.
 */
export function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const totalKB = Math.round(output.length / 1024);
  const truncatedKB = Math.round((output.length - MAX_TOOL_OUTPUT_CHARS) / 1024);
  return (
    output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n\n... [truncated ${String(truncatedKB)} KB of ${String(totalKB)} KB total; full output preserved in run history]`
  );
}

/**
 * Parse message metadata JSON, apply truncateToolOutput to every toolCall output,
 * and return the re-serialized JSON string.
 *
 * Safe to call on any metadata string — passes through unchanged when:
 * - the string is not valid JSON
 * - the parsed value has no toolCalls array
 * - all tool outputs are within the cap
 */
export function boundMetadataToolOutputs(metaJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaJson);
  } catch {
    return metaJson;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>).toolCalls)
  ) {
    return metaJson;
  }
  const meta = parsed as { toolCalls: Record<string, unknown>[] };
  const bounded = {
    ...meta,
    toolCalls: meta.toolCalls.map(tc =>
      typeof tc.output === 'string' ? { ...tc, output: truncateToolOutput(tc.output) } : tc
    ),
  };
  return JSON.stringify(bounded);
}
