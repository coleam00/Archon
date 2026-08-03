/**
 * Keep the system awake for the duration of a workflow run (Windows).
 *
 * Holds a Windows execution-state request (`SetThreadExecutionState` with
 * `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`) while ≥1 workflow run is active, so an
 * unattended machine cannot drop into Modern Standby (S0 Low Power Idle) and
 * freeze a mid-DAG executor. Root cause + evidence:
 * `2026-07-05-archon-mid-run-death-problem-record.md` — a standby-frozen
 * executor thaws into bash spawns that exit 66 (`EX_NOINPUT`) with no output,
 * collapsing the DAG tail; other casualties present as zombie `running` rows.
 *
 * Best-effort by design: on non-Windows, or if `bun:ffi` / kernel32 is
 * unavailable, every method is a no-op, and the native calls themselves are
 * try/catch-guarded. A keep-awake failure must NEVER block or fail a workflow
 * run (intentional, documented fallback — the CLAUDE.md fail-fast rule's
 * sanctioned exception).
 *
 * The screen is allowed to turn off — we request `ES_SYSTEM_REQUIRED` only, not
 * `ES_DISPLAY_REQUIRED`. The per-thread execution state is cleared by the OS on
 * process exit, so a crash mid-run leaks nothing.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { createLogger } from '@archon/paths';

/** `SetThreadExecutionState` flags (winbase.h). */
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

/**
 * Combined acquire flags, coerced to UNSIGNED. `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`
 * evaluates to a negative int32 in JS (the `0x80000000` sign bit is set); `>>> 0`
 * reinterprets the bit pattern as the uint32 `0x80000001` the Win32 API expects.
 */
const ACQUIRE_FLAGS = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0;
/** `ES_CONTINUOUS` alone clears all prior flags — this IS the release mechanism, not a bug. */
const RELEASE_FLAGS = ES_CONTINUOUS >>> 0;

/** Native `SetThreadExecutionState(flags)` → previous state (0 on failure). */
type SetExecStateFn = (flags: number) => number;

export interface KeepAwake {
  acquire(): void;
  release(): void;
  /** Current refcount — exposed for tests. */
  activeCount(): number;
}

/**
 * Lazy-initialized logger. Deferred until first use in the common case; the
 * one import-time invocation is `loadNative()`'s catch path (Windows dlopen
 * failure), which is acceptable — it's already an error-reporting path.
 */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.keep-awake');
  return cachedLog;
}

/**
 * Create a refcounted keep-awake controller.
 *
 * Refcounting (not a boolean) is required because a single server process runs
 * concurrent workflow runs — the request must be held until the LAST active run
 * releases it.
 *
 * @param setExecState Native `SetThreadExecutionState`, or `undefined` to disable
 *   (non-Windows / unavailable FFI). When disabled the refcount is still tracked
 *   so `activeCount()` stays meaningful, but no native call is ever made.
 * @param platform Host platform (injectable for tests); native calls fire only
 *   on `win32`.
 */
export function createKeepAwake(
  setExecState: SetExecStateFn | undefined,
  platform: NodeJS.Platform = process.platform
): KeepAwake {
  // `native` undefined ⇒ every method keeps the refcount but makes no syscall.
  const native: SetExecStateFn | undefined = platform === 'win32' ? setExecState : undefined;
  let count = 0;

  return {
    acquire(): void {
      count += 1;
      if (!native || count !== 1) return;
      // try/catch enforces the module contract: a throwing FFI call here would
      // otherwise escape into executeWorkflow BEFORE its try block and leave
      // the run row stuck 'running' — the exact zombie class this module fights.
      try {
        const previous = native(ACQUIRE_FLAGS);
        if (previous === 0) {
          // API failure: refcount already incremented so release stays paired.
          getLog().warn({ flags: ACQUIRE_FLAGS }, 'keepawake.acquire_failed');
          return;
        }
        getLog().info({ activeCount: count }, 'keepawake.acquire_completed');
      } catch (error) {
        getLog().warn({ err: error as Error, flags: ACQUIRE_FLAGS }, 'keepawake.acquire_failed');
      }
    },
    release(): void {
      if (count === 0) {
        // Should never fire (executor pairs acquire/release via try/finally);
        // include a stack so an unbalanced call site is findable if it does.
        getLog().warn({ stack: new Error().stack }, 'keepawake.release_unbalanced');
        return;
      }
      count -= 1;
      if (!native || count !== 0) return;
      // try/catch: a throw from the first statement of the executor's finally
      // would replace the run's return value and skip the zombie backstop.
      try {
        const previous = native(RELEASE_FLAGS);
        if (previous === 0) {
          // Failed clear leaves ES_SYSTEM_REQUIRED asserted until process exit
          // — the host cannot sleep. Nothing more we can do, but never say
          // "completed" when the OS said no.
          getLog().warn({ flags: RELEASE_FLAGS }, 'keepawake.release_failed');
          return;
        }
        getLog().info({ activeCount: count }, 'keepawake.release_completed');
      } catch (error) {
        getLog().warn({ err: error as Error, flags: RELEASE_FLAGS }, 'keepawake.release_failed');
      }
    },
    activeCount(): number {
      return count;
    },
  };
}

/**
 * Load the native `SetThreadExecutionState` from kernel32.dll via `bun:ffi`.
 * Returns `undefined` off-Windows or on any load failure (best-effort — see
 * the module doc above for why). `bun:ffi` itself resolves on all platforms;
 * only the `dlopen('kernel32.dll')` call is Windows-only, so it stays behind
 * the platform guard.
 */
function loadNative(): SetExecStateFn | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const lib = dlopen('kernel32.dll', {
      SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
    });
    return (flags: number): number => lib.symbols.SetThreadExecutionState(flags);
  } catch (error) {
    getLog().warn(
      { err: error as Error, errorType: (error as Error).constructor.name },
      'keepawake.unavailable'
    );
    return undefined;
  }
}

/**
 * Process-wide keep-awake singleton (see `createKeepAwake` above for the
 * refcounting rationale).
 *
 * Workflow execution never runs in a Worker thread in this codebase, so
 * acquire and clear always land on the same (main) thread — a hard requirement
 * of the per-thread `SetThreadExecutionState` API. If workflow execution ever
 * moves to a Worker, do NOT call these from it.
 */
export const keepAwake: KeepAwake = createKeepAwake(loadNative(), process.platform);
