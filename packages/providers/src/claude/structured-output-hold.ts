import type {
  HookCallback,
  HookCallbackMatcher,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
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
export function holdStructuredOutputWhileSubtasksRun(
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
