import { z } from 'zod';
import { providerResultSchema } from './result';
import { providerSettledSchema } from './settled';

/**
 * The non-terminal events a provider streams during a turn. Names follow the Agent Client
 * Protocol (ACP, agentclientprotocol.com) where ACP has the concept; each field says whether
 * it comes from ACP or is an Archon addition. ACP discriminates session updates on
 * `sessionUpdate`; this contract discriminates on `type`, the key `result` and `settled`
 * already use, so one stream has one discriminator.
 *
 * Text events carry a whole block, not a token delta: a provider coalesces deltas and sends
 * the block at a block, tool or turn boundary.
 */

/** ACP `agent_message_chunk`. */
export const agentMessageChunkSchema = z.object({
  type: z.literal('agent_message_chunk'),
  /** One whole block of the agent's reply. ACP wraps it in a `content` block; Archon carries the text. */
  text: z.string().min(1),
});

/** ACP `agent_thought_chunk`. */
export const agentThoughtChunkSchema = z.object({
  type: z.literal('agent_thought_chunk'),
  /** One whole block of the agent's reasoning, as `agent_message_chunk.text`. */
  text: z.string().min(1),
});

/** ACP `tool_call`: the agent started a tool. */
export const toolCallSchema = z.object({
  type: z.literal('tool_call'),
  /**
   * ACP `toolCallId`. The provider's own id for the call, unique within the turn. The
   * engine never mints one: a provider whose SDK gives no id must make one up itself.
   */
  toolCallId: z.string().min(1),
  /** ACP `name` (optional there), the tool's programmatic name. Required here: every reader shows it. */
  name: z.string(),
  /** ACP `title` (required there), a human-readable label such as the command a shell tool runs. */
  title: z.string().optional(),
  /** ACP `rawInput`. Archon narrows it to an object, which is what every SDK sends. */
  rawInput: z.record(z.string(), z.unknown()).optional(),
});

/** Longest `tool_call_update.output` the contract accepts, in UTF-16 code units (`String.length`). */
export const TOOL_OUTPUT_MAX_CHARS = 16_384;

/**
 * How a tool call ended. ACP `completed` and `failed`; `cancelled` is an Archon addition
 * for a call the turn interrupted before it finished. ACP's non-terminal `pending` and
 * `in_progress` are left out: a tool call has one update, the one that closes it.
 */
export const toolCallStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

/** ACP `tool_call_update`, restricted to the one update that closes a call. */
export const toolCallUpdateSchema = z.object({
  type: z.literal('tool_call_update'),
  /** ACP `toolCallId`; matches an earlier `tool_call`. */
  toolCallId: z.string().min(1),
  /** ACP `status`, terminal values only. */
  status: toolCallStatusSchema,
  /**
   * Archon addition: the tool's output as text, capped at `TOOL_OUTPUT_MAX_CHARS`. ACP
   * carries output as `content` blocks or `rawOutput`. The provider truncates with
   * `truncateToolOutput`, so the stored output is the one it emitted.
   */
  output: z.string().max(TOOL_OUTPUT_MAX_CHARS).optional(),
  /** Archon addition: set only when `truncateToolOutput` cut the output. */
  outputTruncated: z.literal(true).optional(),
  /** Archon addition: the exit code of a tool that runs a process, when the SDK reports one. */
  exitCode: z.number().int().optional(),
});

/** Archon addition (ACP has no warning update): something the operator should see that did not fail the turn. */
export const providerWarningSchema = z.object({
  /** Provider-namespaced identifier, such as `claude.node_config_ignored`. Readers branch on this, never on `message`. */
  code: z.string().min(1),
  /** Text for the operator. */
  message: z.string(),
});
export type ProviderWarning = z.infer<typeof providerWarningSchema>;

export const warningSchema = providerWarningSchema.extend({ type: z.literal('warning') });

/**
 * Archon addition (ACP has no MCP status update): the state of one MCP server the turn
 * configured. The values are the Claude Agent SDK's `McpServerStatus` states.
 */
export const mcpServerStatusSchema = z.object({
  type: z.literal('mcp_server_status'),
  /** The server's name as configured. */
  server: z.string().min(1),
  status: z.enum(['connected', 'failed', 'needs_auth', 'pending', 'disabled']),
  /** The vendor's error text, for the operator. Nothing branches on it. */
  error: z.string().optional(),
});

/** ACP session compaction (a Preview feature there): the provider shrank the context window. */
export const compactionSchema = z.object({
  type: z.literal('compaction'),
  phase: z.enum(['started', 'completed']),
  /** Archon addition: whether the user asked for it or the provider ran it on its own. */
  trigger: z.enum(['manual', 'auto']).optional(),
  /** Archon addition: context tokens before compaction. */
  tokensBefore: z.number().int().nonnegative().optional(),
  /** Archon addition: context tokens after compaction. */
  tokensAfter: z.number().int().nonnegative().optional(),
});

/** Statuses that end a subtask. Conformance requires every started subtask to reach one before `settled`. */
export const subtaskTerminalStatusSchema = z.enum(['completed', 'failed', 'stopped']);

/**
 * Archon addition (ACP has no subtask update): work the agent delegated, such as a Claude
 * subagent. Each event upserts the subtask by `taskId`, as ACP tool call updates do by id.
 */
export const subtaskSchema = z.object({
  type: z.literal('subtask'),
  /** The provider's id for the subtask. */
  taskId: z.string().min(1),
  status: z.enum(['started', 'running', ...subtaskTerminalStatusSchema.options]),
  /** What the subtask is doing, for the operator. */
  description: z.string().optional(),
  /** The latest progress or final summary. */
  summary: z.string().optional(),
  /** The provider's kind of subtask, such as `local_agent`. */
  taskType: z.string().optional(),
  /** The `toolCallId` of the tool call that started the subtask. */
  parentToolCallId: z.string().optional(),
  /** The last tool the subtask ran. */
  lastToolName: z.string().optional(),
  /** Where the provider wrote the subtask's output. */
  outputFile: z.string().optional(),
  /** Usage the provider reports for the subtask, passed through untyped. */
  usage: z.record(z.string(), z.unknown()).optional(),
});

/** Archon addition (ACP has no hook update): a user-configured hook ran. */
export const hookSchema = z.object({
  type: z.literal('hook'),
  /** The provider's id for this hook run; the start and the end share it. */
  hookId: z.string().min(1),
  hookName: z.string(),
  /** The event that fired the hook, such as `PreToolUse`. */
  hookEvent: z.string(),
  status: z.enum(['started', 'succeeded', 'failed', 'cancelled']),
  exitCode: z.number().int().optional(),
});

/**
 * ACP v2 `state_update`. ACP's `idle` is left out: the end of a turn is `settled`, and
 * two terminal signals would have to be kept in agreement.
 */
export const stateUpdateSchema = z.object({
  type: z.literal('state_update'),
  /** `requires_action`: the agent waits on the user, such as for a permission answer. */
  state: z.enum(['running', 'requires_action']),
});

/** Every non-terminal event a provider may stream. */
export const providerEventSchema = z.discriminatedUnion('type', [
  agentMessageChunkSchema,
  agentThoughtChunkSchema,
  toolCallSchema,
  toolCallUpdateSchema,
  warningSchema,
  mcpServerStatusSchema,
  compactionSchema,
  subtaskSchema,
  hookSchema,
  stateUpdateSchema,
]);
export type ProviderEvent = z.infer<typeof providerEventSchema>;

/** Everything a provider's stream may yield: its events, then `result`, then `settled`. */
export const providerChunkSchema = z.discriminatedUnion('type', [
  providerEventSchema,
  providerResultSchema.extend({ type: z.literal('result') }),
  providerSettledSchema,
]);
export type ProviderChunk = z.infer<typeof providerChunkSchema>;

/**
 * Caps tool output at `TOOL_OUTPUT_MAX_CHARS`. The cut never splits a surrogate pair,
 * because a lone surrogate is invalid in PostgreSQL `jsonb`.
 */
export function truncateToolOutput(text: string): { output: string; outputTruncated?: true } {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return { output: text };
  const lastKept = text.charCodeAt(TOOL_OUTPUT_MAX_CHARS - 1);
  const isHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  const end = isHighSurrogate ? TOOL_OUTPUT_MAX_CHARS - 1 : TOOL_OUTPUT_MAX_CHARS;
  return { output: text.slice(0, end), outputTruncated: true };
}
