import type {
  HookCallback,
  HookCallbackMatcher,
  StopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import type { MessageChunk } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/** The subtasks the stream reports open, and a wait for the last of them to close. */
export class OpenSubtasks {
  private readonly ids = new Set<string>();
  private waiters: (() => void)[] = [];

  get size(): number {
    return this.ids.size;
  }

  track(chunk: Extract<MessageChunk, { type: 'subtask' }>): void {
    if (chunk.status === 'started' || chunk.status === 'running') this.ids.add(chunk.taskId);
    else this.ids.delete(chunk.taskId);
    if (this.ids.size === 0) for (const release of this.waiters.splice(0)) release();
  }

  /** Resolves when none is open, or when `signal` aborts. */
  allClosed(signal: AbortSignal): Promise<void> {
    if (this.ids.size === 0 || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const release = (): void => {
        signal.removeEventListener('abort', release);
        this.waiters = this.waiters.filter(waiter => waiter !== release);
        resolve();
      };
      this.waiters.push(release);
      signal.addEventListener('abort', release, { once: true });
    });
  }
}

// Long enough for any helper. A shorter timeout ends the turn while helpers still run,
// and the CLI's default hook timeout is minutes. A helper that dies without a
// notification is bounded by the node's idle watchdog, not by this timeout.
const HOLD_TIMEOUT_SECONDS = 24 * 60 * 60;

/**
 * Claude Code asks for the structured result whenever a turn ends, including a turn that
 * ends only to wait for background helpers, and an agent that answers then gives a result
 * its helpers' work never reaches (#5923). This Stop hook holds the main agent's turn end
 * while the stream reports a subtask open, then sends the agent back to read the helpers'
 * results and answer. The agent sees the CLI's request for the result only after the hold.
 *
 * The hold never refuses a StructuredOutput call: Claude Code counts every call toward its
 * structured-output retry limit, refused or not, and ends the query with
 * `error_max_structured_output_retries` after the fifth with none accepted.
 */
export function holdTurnEndWhileSubtasksRun(subtasks: OpenSubtasks): HookCallbackMatcher {
  return {
    timeout: HOLD_TIMEOUT_SECONDS,
    hooks: [
      (async (input: StopHookInput, _toolUseId, { signal }) => {
        // A helper's own turn end carries its agent_id; only the main agent is held.
        if (input.agent_id !== undefined || subtasks.size === 0) return { continue: true };
        getLog().info({ openSubtasks: subtasks.size }, 'claude.turn_end_held');
        await subtasks.allClosed(signal);
        if (signal.aborted) return { continue: true };
        return {
          decision: 'block',
          reason:
            'The background work you started has finished. Read its results and continue your task. Give your result when the task is done; a result you give now replaces any earlier one.',
        };
      }) as HookCallback,
    ],
  };
}
