/**
 * Workflow heartbeat — periodic "still working" notifications for chat platforms.
 *
 * Long-running workflows (e.g. `archon-slack-feature-to-review-app`) have
 * nodes that can run silently for many minutes (batch-mode sends, `ci-wait`,
 * parallel review agents, etc.). Without liveness signals, users assume the
 * workflow is hung. This module subscribes to the workflow event emitter to
 * track currently-running nodes, then posts a compact status line on a timer
 * so the thread keeps moving.
 *
 * Scope (per design selection):
 * - Runs only for chat platforms (slack, telegram, discord). Web UI and CLI
 *   already stream their own progress indicators.
 * - Fires every `intervalMs` (default 60s). Nodes must have been running at
 *   least `intervalMs` before we ping — fast nodes are never surfaced.
 * - Each node emits at most one heartbeat per tick; re-emits on subsequent
 *   ticks only if the node is still running.
 * - Messages include last tool call when available for richer progress signal.
 *
 * Called by `executor.ts` around `executeDagWorkflow`: started after the
 * `workflow_started` event, stopped in the outer `finally` block so it
 * terminates on completion, failure, pause, or cancellation.
 */
import type { IWorkflowPlatform, WorkflowMessageMetadata } from './deps';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from './event-emitter';

/** Minimal subscribe surface used by the heartbeat — matches WorkflowEventEmitter. */
export interface HeartbeatEmitter {
  subscribe(listener: (event: WorkflowEmitterEvent) => void): () => void;
}
import { formatDuration } from './utils/duration';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.heartbeat');
  return cachedLog;
}

/** Default tick interval — also the minimum age a node must reach before pinging. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** Chat platforms that benefit from heartbeats (batch mode default + multi-minute silences). */
const HEARTBEAT_PLATFORMS = new Set(['slack', 'telegram', 'discord']);

/**
 * Tracked state for a currently-executing node. Populated on `node_started`
 * and cleared on completion/failure/skip. `lastToolName` is refreshed on each
 * `tool_started` so heartbeats can surface the most recent activity.
 */
interface ActiveNodeState {
  nodeId: string;
  nodeName: string;
  startedAt: number;
  /** When the last heartbeat for this node fired (ms since epoch). */
  lastHeartbeatAt?: number;
  lastToolName?: string;
  lastToolStartedAt?: number;
}

export interface HeartbeatOptions {
  runId: string;
  platform: IWorkflowPlatform;
  conversationId: string;
  /** Defaults to DEFAULT_HEARTBEAT_INTERVAL_MS when omitted. */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable scheduler for tests — must return a handle compatible with clearInterval. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  /** Override platform filter — test injection point. */
  shouldEmitForPlatform?: (platformType: string) => boolean;
  /** Override event emitter — test injection point. Defaults to the singleton. */
  emitter?: HeartbeatEmitter;
}

export interface HeartbeatHandle {
  stop: () => void;
  /** Exposed for tests — invoked internally by the interval timer. */
  tick: () => Promise<void>;
}

/**
 * Start the heartbeat loop for a workflow run. Returns a handle whose
 * `stop()` unsubscribes from events and clears the timer. Calling `stop`
 * more than once is safe (idempotent).
 *
 * Returns a no-op handle when the platform is not a chat adapter, so
 * callers can wrap every run unconditionally without branching.
 */
export function startWorkflowHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const {
    runId,
    platform,
    conversationId,
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    now = Date.now,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
    shouldEmitForPlatform = (t: string): boolean => HEARTBEAT_PLATFORMS.has(t),
  } = options;

  const platformType = platform.getPlatformType();
  if (!shouldEmitForPlatform(platformType)) {
    return {
      stop: (): void => {
        /* no-op for non-chat platforms */
      },
      tick: async (): Promise<void> => {
        /* no-op for non-chat platforms */
      },
    };
  }

  const workflowStartedAt = now();
  const activeNodes = new Map<string, ActiveNodeState>();

  const emitter: HeartbeatEmitter = options.emitter ?? getWorkflowEventEmitter();
  const unsubscribe = emitter.subscribe((event: WorkflowEmitterEvent) => {
    if (event.runId !== runId) return;

    switch (event.type) {
      case 'node_started': {
        activeNodes.set(event.nodeId, {
          nodeId: event.nodeId,
          nodeName: event.nodeName,
          startedAt: now(),
        });
        break;
      }
      case 'node_completed':
      case 'node_failed':
      case 'node_skipped': {
        activeNodes.delete(event.nodeId);
        break;
      }
      case 'tool_started': {
        // `stepName` === nodeId for DAG nodes (see dag-executor emissions).
        const state = activeNodes.get(event.stepName);
        if (state) {
          state.lastToolName = event.toolName;
          state.lastToolStartedAt = now();
        }
        break;
      }
      default:
        break;
    }
  });

  const tick = async (): Promise<void> => {
    if (activeNodes.size === 0) return;
    const tickNow = now();
    const linesToPost: string[] = [];

    for (const state of activeNodes.values()) {
      const nodeAge = tickNow - state.startedAt;
      if (nodeAge < intervalMs) continue;

      // Re-pinging: only emit if it's been at least `intervalMs` since the
      // last heartbeat for this node. Without this, an aggressive interval
      // override (e.g. tests) could double-post.
      if (state.lastHeartbeatAt !== undefined && tickNow - state.lastHeartbeatAt < intervalMs) {
        continue;
      }

      state.lastHeartbeatAt = tickNow;
      linesToPost.push(formatHeartbeatLine(state, tickNow));
    }

    if (linesToPost.length === 0) return;

    const totalElapsed = formatDuration(tickNow - workflowStartedAt);
    const body =
      linesToPost.length === 1
        ? `${linesToPost[0]} — ${totalElapsed} total`
        : `⏳ Still working — ${totalElapsed} total\n${linesToPost.map(l => `• ${l}`).join('\n')}`;

    try {
      const metadata: WorkflowMessageMetadata = {
        category: 'workflow_status',
        segment: 'auto',
      };
      await platform.sendMessage(conversationId, body, metadata);
    } catch (error) {
      // Non-fatal: heartbeats are purely informational. Log and move on so a
      // transient platform hiccup never affects the workflow itself.
      getLog().warn(
        { err: error as Error, runId, conversationId, platformType },
        'workflow.heartbeat_send_failed'
      );
    }
  };

  const handle = setIntervalFn(() => {
    void tick();
  }, intervalMs);

  // Don't keep the process alive just for heartbeats — the workflow executor
  // owns the lifecycle; if it exits the heartbeat should not block shutdown.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }

  let stopped = false;
  return {
    tick,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      try {
        clearIntervalFn(handle);
      } catch (err) {
        getLog().warn({ err: err as Error, runId }, 'workflow.heartbeat_clear_failed');
      }
      try {
        unsubscribe();
      } catch (err) {
        getLog().warn({ err: err as Error, runId }, 'workflow.heartbeat_unsub_failed');
      }
      activeNodes.clear();
    },
  };
}

/**
 * Per-node heartbeat line. Surfaces last tool when known so users see what
 * the node is currently doing instead of just "still running".
 */
function formatHeartbeatLine(state: ActiveNodeState, nowMs: number): string {
  const nodeElapsed = formatDuration(nowMs - state.startedAt);
  let line = `⏳ Still working on \`${state.nodeName}\` — ${nodeElapsed} on this step`;

  if (state.lastToolName && state.lastToolStartedAt !== undefined) {
    const toolAgo = formatDuration(nowMs - state.lastToolStartedAt);
    line += `, last tool: ${state.lastToolName} (${toolAgo} ago)`;
  }

  return line;
}
