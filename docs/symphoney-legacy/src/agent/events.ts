/**
 * Event types emitted to the orchestrator. The exact Codex protocol shapes are
 * version-dependent; this module owns the *normalized* representation.
 */
export type AgentEventType =
  | "session_started"
  | "startup_failed"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "approval_auto_approved"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "rate_limits_updated"
  | "malformed";

export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface AgentEvent {
  event: AgentEventType;
  timestamp: string;
  codex_app_server_pid?: number | null;
  thread_id?: string | null;
  turn_id?: string | null;
  session_id?: string | null;
  message?: string | null;
  usage?: TokenUsage | null;
  rate_limits?: unknown;
  raw?: unknown;
}

/**
 * Extract token usage from a Codex protocol payload.
 *
 * Per spec §13.5:
 * - prefer absolute thread totals (`thread/tokenUsage/updated`, `total_token_usage`)
 * - ignore delta-style payloads like `last_token_usage`
 * - extract input/output/total leniently
 *
 * Returns `null` when the payload is not a recognized absolute-totals shape.
 */
export function extractAbsoluteTokenUsage(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  // Common shapes we'll recognize:
  // - { type: "thread/tokenUsage/updated", usage: { input_tokens, output_tokens, total_tokens } }
  // - { total_token_usage: { input, output, total } }
  // - { token_usage: { ... } } when type indicates absolute totals
  const type = typeof obj.type === "string" ? obj.type : "";

  if (type.endsWith("last_token_usage") || type.endsWith("turn_token_usage")) {
    return null;
  }

  const candidates: unknown[] = [
    obj.total_token_usage,
    obj.token_usage,
    obj.usage,
    obj.tokenUsage,
  ];

  for (const c of candidates) {
    if (c && typeof c === "object") {
      const u = c as Record<string, unknown>;
      const input = pickNumber(u.input_tokens, u.input, u.prompt_tokens);
      const output = pickNumber(u.output_tokens, u.output, u.completion_tokens);
      const total = pickNumber(u.total_tokens, u.total);
      if (input !== null || output !== null || total !== null) {
        return {
          input_tokens: input,
          output_tokens: output,
          total_tokens: total ?? (input !== null && output !== null ? input + output : null),
        };
      }
    }
  }
  return null;
}

function pickNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  }
  return null;
}
