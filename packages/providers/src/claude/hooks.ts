/**
 * The SDK hooks every Claude query registers: tool-result capture for the stream, and
 * the hold on a structured result while background work runs.
 */
import type {
  HookCallback,
  HookCallbackMatcher,
  Options,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { truncateToolOutput } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import type { ToolResultEntry } from './stream';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/** The query's hooks; the structured-result hold only when the query asks for one. */
export function buildProviderHooks(
  toolResultQueue: ToolResultEntry[],
  openSubtaskIds: ReadonlySet<string>,
  requestsStructuredOutput: boolean
): NonNullable<Options['hooks']> {
  return {
    ...buildToolCaptureHooks(toolResultQueue),
    ...(requestsStructuredOutput
      ? { PreToolUse: [holdStructuredOutputWhileSubtasksRun(openSubtaskIds)] }
      : {}),
  };
}

/**
 * Build SDK hooks that capture tool use results into a shared queue.
 * The queue is drained during stream normalization.
 */
function buildToolCaptureHooks(toolResultQueue: ToolResultEntry[]): NonNullable<Options['hooks']> {
  return {
    PostToolUse: [
      {
        hooks: [
          (async (input: PostToolUseHookInput): Promise<{ continue: true }> => {
            try {
              const response = input.tool_response;
              const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
              const update: ToolResultEntry = {
                type: 'tool_call_update',
                toolCallId: input.tool_use_id,
                status: 'completed',
                ...truncateToolOutput(text),
              };
              toolResultQueue.push(update);
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          (async (input: PostToolUseFailureHookInput): Promise<{ continue: true }> => {
            try {
              const update: ToolResultEntry = {
                type: 'tool_call_update',
                toolCallId: input.tool_use_id,
                status: input.is_interrupt === true ? 'cancelled' : 'failed',
                ...truncateToolOutput(input.error),
              };
              toolResultQueue.push(update);
            } catch (e) {
              getLog().error({ err: e, input }, 'claude.post_tool_use_failure_hook_error');
            }
            return { continue: true };
          }) as HookCallback,
        ],
      },
    ],
  };
}

/**
 * Claude Code asks for the structured result whenever a turn ends, including a turn
 * that ends only to wait for background helpers, and an agent that answers then gives a
 * result its helpers' work never reaches (#5923). Refusing the main agent's call while
 * the provider reports a subtask open makes it end the turn without a result; the CLI
 * wakes it when a helper finishes, and it answers once none is left.
 *
 * `openSubtaskIds` is the stream's view, so it trails the CLI by the events the
 * consumer has not read yet. A dead helper does not hold the node forever: the stream
 * already refuses to settle while a subtask is open, and the node's idle watchdog ends it.
 */
function holdStructuredOutputWhileSubtasksRun(
  openSubtaskIds: ReadonlySet<string>
): HookCallbackMatcher {
  return {
    matcher: 'StructuredOutput',
    hooks: [
      (async (input: PreToolUseHookInput) => {
        // A helper's own tool calls carry its agent_id; only the main agent is held.
        if (input.agent_id !== undefined || openSubtaskIds.size === 0) return { continue: true };
        getLog().info({ openSubtasks: openSubtaskIds.size }, 'claude.structured_output_held');
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'Background work you started is still running. End your turn without calling StructuredOutput; you are woken when it finishes, then give the result.',
          },
        };
      }) as HookCallback,
    ],
  };
}
