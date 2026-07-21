/**
 * Maximum characters of a single tool output sent across a server → browser
 * boundary (SSE tool_result events and message-hydration metadata).
 *
 * The console renderer displays at most 2000 chars of a tool result
 * (ToolCallItem.tsx), so 16 KiB is invisible to display behavior while leaving
 * ~8x headroom for future renderer changes. The full output stays in the
 * database and on-disk logs — this cap is transport hygiene only.
 */
export const MAX_TOOL_OUTPUT_CHARS = 16_384;

/**
 * Bound tool output to MAX_TOOL_OUTPUT_CHARS for browser transport.
 * Returns the string unchanged when within the cap; otherwise returns a head
 * slice plus a human-readable size marker (mirroring the renderer's own
 * head-slice + "(N more chars)" cap semantics) so users know truncation
 * occurred and where the full output lives.
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
    `\n\n… [truncated ${String(truncatedKB)} KB of ${String(totalKB)} KB total; full output preserved on the server]`
  );
}

/**
 * Parse message metadata JSON, apply truncateToolOutput to every toolCalls[]
 * output, and return the re-serialized JSON string.
 *
 * Truncates ONLY tool_result content — all other metadata fields
 * (workflowDispatch, workflowResult, file uploads, …) pass through untouched.
 * Returns the input string byte-for-byte unchanged when:
 * - the string is not valid JSON
 * - the parsed value has no toolCalls array
 * - every tool output is already within the cap
 */
export function boundMetadataToolOutputs(metaJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaJson);
  } catch {
    return metaJson;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>).toolCalls)
  ) {
    return metaJson;
  }
  const meta = parsed as { toolCalls: unknown[] } & Record<string, unknown>;
  let truncatedAny = false;
  const boundedToolCalls = meta.toolCalls.map(tc => {
    if (tc === null || typeof tc !== 'object') return tc;
    const toolCall = tc as Record<string, unknown>;
    if (typeof toolCall.output !== 'string' || toolCall.output.length <= MAX_TOOL_OUTPUT_CHARS) {
      return tc;
    }
    truncatedAny = true;
    return { ...toolCall, output: truncateToolOutput(toolCall.output) };
  });
  // Avoid re-serialization churn when nothing was truncated
  if (!truncatedAny) return metaJson;
  return JSON.stringify({ ...meta, toolCalls: boundedToolCalls });
}
