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
 * unavailable, every method is a no-op. A keep-awake failure must NEVER block
 * or fail a workflow run (intentional, documented fallback — the CLAUDE.md
 * fail-fast rule's sanctioned exception).
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
  /** Current refcount — exposed for tests and diagnostics. */
  activeCount(): number;
}

/** Lazy-initialized logger (deferred so it has no module-load side effects). */
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
      const previous = native(ACQUIRE_FLAGS);
      if (previous === 0) {
        // API failure: refcount already incremented so release stays paired.
        getLog().warn({ flags: ACQUIRE_FLAGS }, 'keepawake.acquire_failed');
        return;
      }
      getLog().info({ activeCount: count }, 'keepawake.acquire_completed');
    },
    release(): void {
      if (count === 0) {
        getLog().warn({}, 'keepawake.release_unbalanced');
        return;
      }
      count -= 1;
      if (!native || count !== 0) return;
      native(RELEASE_FLAGS);
      getLog().info({ activeCount: count }, 'keepawake.release_completed');
    },
    activeCount(): number {
      return count;
    },
  };
}

/**
 * Load the native `SetThreadExecutionState` from kernel32.dll via `bun:ffi`.
 * Returns `undefined` off-Windows or on any load failure.
 *
 * Intentional, documented fallback: keep-awake is best-effort — a missing
 * symbol or FFI failure must never block workflow execution, and the OS clears
 * the per-thread execution state on process exit regardless. `bun:ffi` itself
 * resolves on all platforms; only the `dlopen('kernel32.dll')` is Windows-only,
 * so it stays behind the platform guard.
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
 * Process-wide keep-awake singleton. Refcounted so concurrent runs in one
 * server process hold a single execution-state request until the LAST finishes.
 *
 * Bun runs all JS on one thread, so acquire and clear land on the same thread —
 * a hard requirement of the per-thread `SetThreadExecutionState` API. Do NOT
 * move these calls into a Worker.
 */
export const keepAwake: KeepAwake = createKeepAwake(loadNative(), process.platform);
