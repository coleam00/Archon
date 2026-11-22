import { dlopen, FFIType, ptr } from 'bun:ffi';
import { appendFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { SCHEDULE_LAUNCH_FLAG } from './schedule-launch-flag';

/*
 * The second hop of a Windows schedule tick: run the job's `.cmd` wrapper on a desktop
 * nobody looks at.
 *
 * The task's action is `conhost.exe --headless`, which gives this process a console with no
 * window. That alone hides only the first window. The tick's run owner is started detached,
 * and on Windows a detached process has no console, so every console program it or its
 * agents start opens a console window of its own, and a browser always does. Windows puts a
 * new process on its parent's desktop, detached or not, so starting the wrapper on a separate
 * desktop keeps the run's whole process tree, and every window it opens, off the operator's
 * screen. The task still runs as the logged-on user with an interactive token, so Credential
 * Manager stays readable. Nothing on this desktop can be seen: a process that waits for a
 * prompt (an expired Git Credential Manager login) waits unseen.
 */

/** One desktop for every Archon schedule; CreateDesktopW opens it when it already exists. */
export const SCHEDULE_DESKTOP = 'ArchonSchedules';

const DESKTOP_CREATEWINDOW = 0x0002;
const DESKTOP_READOBJECTS = 0x0001;
const INFINITE = 0xffffffff;
const WAIT_FAILED = 0xffffffff;
/**
 * `sizeof(STARTUPINFOW)` on 64-bit Windows; `lpDesktop` is the pointer at 16, after `cb`, its
 * padding and `lpReserved`.
 */
const STARTUPINFO_BYTES = 104;
const DESKTOP_OFFSET = 16;
/** `sizeof(PROCESS_INFORMATION)`: `hProcess` at 0, `hThread` at 8. */
const PROCESS_INFORMATION_BYTES = 24;

function openNative() {
  // Handles are u64, as in core's windows-run-job.ts; a null handle is `0n`.
  const user32 = dlopen('user32.dll', {
    CreateDesktopW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.u64,
    },
    CloseDesktop: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
  const kernel32 = dlopen('kernel32.dll', {
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
  return { user32, kernel32 };
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf16le');
}

class NativeCallError extends Error {
  constructor(call: string, lastError: number) {
    super(`${call} failed (GetLastError ${String(lastError)})`);
    this.name = 'NativeCallError';
  }
}

/** The task action's own command line for the wrapper, unchanged from a task without this hop. */
function wrapperCommandLine(wrapper: string): string {
  const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return `"${win32.join(system32, 'cmd.exe')}" /d /v:off /s /c ""${wrapper}""`;
}

/**
 * Run `wrapper` through cmd.exe on the schedule desktop, wait for it, and return its exit
 * code. It inherits this process's environment, which is the task's: the wrapper sets
 * `ARCHON_HOME` and `PATH` itself. Throws when a native call fails.
 */
export function launchOnHiddenDesktop(wrapper: string): number {
  if (process.platform !== 'win32') {
    throw new Error('A schedule desktop exists only on Windows');
  }
  const { user32, kernel32 } = openNative();
  const fail = (call: string): NativeCallError =>
    new NativeCallError(call, kernel32.GetLastError());

  const desktop = user32.CreateDesktopW(
    wideString(SCHEDULE_DESKTOP),
    null,
    null,
    0,
    DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS,
    null
  );
  if (desktop === 0n) throw fail('CreateDesktopW');
  try {
    // The buffers stay referenced until CreateProcessW returns, so their pointers stay valid.
    const desktopName = wideString(`WinSta0\\${SCHEDULE_DESKTOP}`);
    const startup = Buffer.alloc(STARTUPINFO_BYTES);
    startup.writeUInt32LE(STARTUPINFO_BYTES, 0);
    startup.writeBigUInt64LE(BigInt(ptr(desktopName)), DESKTOP_OFFSET);
    const information = Buffer.alloc(PROCESS_INFORMATION_BYTES);
    // CreateProcessW may write to the command line, so it is a buffer of its own.
    const commandLine = wideString(wrapperCommandLine(wrapper));
    // No inherited handles and no environment block: cmd gets this process's console, which
    // has no window, and its environment.
    if (
      kernel32.CreateProcessW(
        null,
        commandLine,
        null,
        null,
        0,
        0,
        null,
        null,
        startup,
        information
      ) === 0
    ) {
      throw fail('CreateProcessW');
    }
    const child = information.readBigUInt64LE(0);
    kernel32.CloseHandle(information.readBigUInt64LE(8));
    try {
      // The task instance lasts as long as the wrapper, so IgnoreNew still keeps ticks apart.
      if (kernel32.WaitForSingleObject(child, INFINITE) === WAIT_FAILED) {
        throw fail('WaitForSingleObject');
      }
      const exitCode = Buffer.alloc(4);
      if (kernel32.GetExitCodeProcess(child, exitCode) === 0) throw fail('GetExitCodeProcess');
      return exitCode.readUInt32LE(0);
    } finally {
      kernel32.CloseHandle(child);
    }
  } finally {
    user32.CloseDesktop(desktop);
  }
}

/**
 * The task's entry point. This process's output goes to a console with no window and is
 * lost, so a failure is appended to the job's log, where `schedule status` and the operator
 * look. The exit code goes to conhost, which does not pass it on, so Task Scheduler's last
 * result never shows it: the log is the only record of a launcher failure.
 */
export function runScheduleLaunch(wrapper: string | undefined): number {
  if (wrapper === undefined || !wrapper.endsWith('.cmd')) {
    process.stderr.write(`Usage: archon ${SCHEDULE_LAUNCH_FLAG} <wrapper.cmd>\n`);
    return 2;
  }
  try {
    return launchOnHiddenDesktop(wrapper);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendFileSync(
      `${wrapper.slice(0, -'.cmd'.length)}.log`,
      `${new Date().toISOString()} archon schedule launcher: ${message}\n`
    );
    return 1;
  }
}
