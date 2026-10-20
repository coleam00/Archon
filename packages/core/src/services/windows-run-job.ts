import { dlopen, FFIType } from 'bun:ffi';
import { randomUUID } from 'node:crypto';
import { WINDOWS_RUN_JOB_STOP_MAX_MS } from './run-stop-bounds';

/*
 * The Windows Job Object that holds a detached run owner's whole process tree.
 *
 * The owner places itself in a new named job before it starts anything. Windows puts
 * every process a job member creates in the same job, whether or not its parent is still
 * alive, and a member can leave only through a breakaway grant this job never gives. So
 * the job's active-process count is the whole tree, orphans included, which no walk of
 * parent PIDs can see once an intermediate process has exited.
 *
 * A detached child does leave the runtime's own kill-on-close job: that job allows silent
 * breakaway, and a process breaking away climbs the job chain until a job that forbids it,
 * which is this one.
 *
 * The name is random rather than derived from the PID or run id: a handle a stopper still
 * holds keeps an old job's name alive, and creating a job under an existing name opens that
 * old job. A random name cannot collide, so it is the owner's identity on its own. It lives
 * in `Global\` so a stop from another session (a desktop operator stopping a service-hosted
 * owner) still finds it.
 */

const JOB_OBJECT_QUERY = 0x0004;
const JOB_OBJECT_TERMINATE = 0x0008;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
/** `sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)`; `ActiveProcesses` is the `DWORD` at 40. */
const ACCOUNTING_INFO_BYTES = 48;
const ACTIVE_PROCESSES_OFFSET = 40;
const TERMINATED_EXIT_CODE = 1;
const POLL_INTERVAL_MS = 50;

type Kernel32 = ReturnType<typeof openKernel32>;

function openKernel32() {
  // Handles are u64 so `GetCurrentProcess()`'s pseudo handle (all bits set) survives as a
  // bigint; a null handle is `0n`.
  return dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
}

let kernel32: Kernel32 | undefined;

function native(): Kernel32 {
  if (process.platform !== 'win32') {
    throw new Error('Windows job objects exist only on Windows');
  }
  kernel32 ??= openKernel32();
  return kernel32;
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, 'utf16le');
}

/** The job this process claimed. Its handle is never closed: the name lives only while a handle is open. */
let claimed: { readonly name: string; readonly handle: bigint } | undefined;

/**
 * Place this process in a new named job and return the job's name. Call it before the
 * process starts anything; later calls return the same name.
 */
export function claimWindowsRunJob(): string {
  if (claimed) return claimed.name;
  const k = native();
  const name = `Global\\archon-run-${randomUUID()}`;
  const fail = (call: string): Error =>
    new Error(
      `Could not place detached workflow owner ${String(process.pid)} in a Windows job object (${call} failed)`
    );
  const handle = k.CreateJobObjectW(null, wideString(name));
  if (handle === 0n) throw fail('CreateJobObjectW');
  if (k.AssignProcessToJobObject(handle, k.GetCurrentProcess()) === 0) {
    k.CloseHandle(handle);
    throw fail('AssignProcessToJobObject');
  }
  claimed = { name, handle };
  return name;
}

/** The name {@link claimWindowsRunJob} returned in this process, if it was called. */
export function currentWindowsRunJob(): string | undefined {
  return claimed?.name;
}

export interface WindowsRunJob {
  /**
   * Terminate every process in the job and return once the job holds none. Throws when
   * that cannot be shown within {@link WINDOWS_RUN_JOB_STOP_MAX_MS}; running out is a
   * failure, never proof that anything died.
   */
  terminate(): Promise<void>;
  close(): void;
}

/**
 * Open the job a detached owner reported. The open handle keeps the job, and so its
 * remaining members, reachable even if the owner exits before {@link WindowsRunJob.terminate}.
 */
export function openWindowsRunJob(name: string, ownerPid: number): WindowsRunJob {
  const k = native();
  const unconfirmed = (detail: string): Error =>
    new Error(
      `Could not confirm detached workflow process tree ${String(ownerPid)} exited: ${detail}`
    );
  const handle = k.OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, wideString(name));
  if (handle === 0n) throw unconfirmed('its job object could not be opened');

  const activeProcesses = (): number => {
    const info = Buffer.alloc(ACCOUNTING_INFO_BYTES);
    const ok = k.QueryInformationJobObject(
      handle,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
      info,
      ACCOUNTING_INFO_BYTES,
      null
    );
    if (ok === 0) throw unconfirmed('its job object could not be queried');
    return info.readUInt32LE(ACTIVE_PROCESSES_OFFSET);
  };

  return {
    terminate: async (): Promise<void> => {
      const deadline = Date.now() + WINDOWS_RUN_JOB_STOP_MAX_MS;
      // A member that was mid-spawn adds a member after a terminate, so terminate again
      // while any remain. A failed call is kept only as evidence; the count is the proof.
      let killFailure: string | undefined;
      for (;;) {
        if (k.TerminateJobObject(handle, TERMINATED_EXIT_CODE) === 0) {
          killFailure = 'TerminateJobObject failed';
        }
        const active = activeProcesses();
        if (active === 0) return;
        if (Date.now() >= deadline) {
          throw unconfirmed(
            `${String(active)} processes in its job are still running` +
              (killFailure ? ` (${killFailure})` : '')
          );
        }
        await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
    close: (): void => {
      k.CloseHandle(handle);
    },
  };
}
