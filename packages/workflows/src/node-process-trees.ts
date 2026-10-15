import { spawn } from 'node:child_process';

export interface NodeProcessRecorder {
  /** In-flight roots and their termination/owner-watcher responsibilities. */
  roots: Map<number, { end(): Promise<void>; disarm(): void }>;
  ended: boolean;
  recordLegacyNodes: boolean;
  end(): Promise<void>;
}
let nodeProcessRecorder: NodeProcessRecorder | undefined;

/**
 * Record the root of every host node subprocess this process starts, so the run
 * owner's interrupt can end those trees before it exits (#3552). Each root leads its
 * own process group on POSIX; `taskkill /T` walks the tree from the PID on Windows.
 *
 * Process-scoped on purpose: only a CLI owner, which drives exactly one run
 * and holds the process-wide signal handlers for it, turns this on.
 * `archon serve` never records. Host node bodies have no owner-death watcher: a
 * stored group ID cannot safely identify a group after its leader exits.
 *
 * `end()` refuses every later recorded node subprocess, so a sibling or retry the executor
 * starts while the owner exits never runs.
 */
export function recordNodeProcessTrees(recordLegacyNodes = true): {
  end(): Promise<void>;
  release(): void;
} {
  const recorder: NodeProcessRecorder = {
    roots: new Map(),
    ended: false,
    recordLegacyNodes,
    end: async () => {
      recorder.ended = true;
      const failed: string[] = [];
      await Promise.all(
        [...recorder.roots].map(([pid, tree]) =>
          tree.end().then(tree.disarm, (error: unknown) => {
            failed.push(
              `${String(pid)} (${error instanceof Error ? error.message : String(error)})`
            );
          })
        )
      );
      if (failed.length > 0) {
        throw new Error(`could not end node process trees: ${failed.join(', ')}`);
      }
    },
  };
  nodeProcessRecorder = recorder;
  return {
    end: recorder.end,
    release: () => {
      if (nodeProcessRecorder === recorder) nodeProcessRecorder = undefined;
    },
  };
}

/** Prepare a detached owner's nodes before acknowledging its termination lease. */
export async function endRecordedNodeProcessTrees(): Promise<void> {
  await nodeProcessRecorder?.end();
}

// A node runs in its own session, so terminal hangup or a second Ctrl-C kills the owner
// without reaching the node, and so does SIGKILL. The watcher sits outside the node's
// group and session: owner death of any kind closes its stdin before the release line.
const NODE_LIFELINE = 'IFS= read -r line || kill -s KILL -- "-$1"';

export function armNodeLifeline(pgid: number, onError: (error: Error) => void): () => void {
  const watcher = spawn('/bin/sh', ['-c', NODE_LIFELINE, 'archon-node-lifeline', String(pgid)], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  watcher.unref();
  watcher.once('error', onError);
  // EPIPE only means the watcher already exited, so there is nothing left to disarm.
  watcher.stdin?.on('error', () => undefined);
  return () => {
    watcher.stdin?.end('\n');
  };
}

export function currentNodeProcessRecorder(): NodeProcessRecorder | undefined {
  return nodeProcessRecorder;
}

export const TERMINATION_CONFIRM_MS = 1000;

export class ProcessGroupStillRunningError extends Error {}

export async function confirmGroupGone(
  pid: number,
  timeout = TERMINATION_CONFIRM_MS
): Promise<void> {
  const deadline = Date.now() + timeout;
  let probeError: unknown;
  while (true) {
    try {
      process.kill(-pid, 0);
      probeError = undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw error;
      probeError = error;
    }
    if (Date.now() >= deadline) {
      throw (
        probeError ?? new ProcessGroupStillRunningError(`Process group ${pid} is still running`)
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}
