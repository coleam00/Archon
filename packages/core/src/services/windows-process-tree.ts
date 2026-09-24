import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/*
 * Stopping a detached run owner's whole process tree on Windows, and proving it stopped.
 *
 * Windows has no process group to signal, so `taskkill /T` kills the tree it can see
 * when it starts. A descendant spawned while that walk runs survives it. The proof here
 * is the process table itself, read through `Get-CimInstance Win32_Process` as JSON:
 * the stop returns only when no member of the owner's tree is listed any more.
 */

const execFileAsync = promisify(execFile);

/** Upper bound on one `taskkill` or process listing. The first CIM query on a machine can take seconds. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * How many listings the stop takes after `taskkill`, killing what each one still shows,
 * before it reports that it could not confirm the tree exited. A bound on attempts, not on
 * time: running out never counts as proof that anything died.
 */
const MAX_CONFIRM_ROUNDS = 5;

export interface WindowsProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  /** Creation time in UTC .NET ticks. Pins the process's identity across PID reuse. */
  readonly created: bigint;
}

export interface WindowsProcessListing {
  /** UTC .NET ticks, read after the table was enumerated. */
  readonly takenAt: bigint;
  readonly rows: readonly WindowsProcessRow[];
}

interface TreeMember {
  readonly pid: number;
  readonly created: bigint;
  /** Time of the first listing that no longer showed this process. */
  goneBy: bigint | undefined;
}

/**
 * The members of one process tree, tracked across successive listings.
 *
 * Membership is identity, never a name: a process joins when its parent is a member,
 * it was created no earlier than that parent, and — when the parent has exited — no
 * later than the listing that first showed the parent gone. Windows keeps a child's
 * `ParentProcessId` after the parent exits, so this still finds a child whose parent was
 * killed before the child was, which is exactly what `taskkill /T` misses.
 *
 * Known limit: a member that exits, has its PID reused, and whose reuser spawns a child
 * before the next listing makes that child indistinguishable from a real descendant.
 * Windows records no parent identity beyond the PID. The window is one listing interval.
 */
export class WindowsProcessTree {
  private readonly members: TreeMember[];

  private constructor(root: WindowsProcessRow) {
    this.members = [{ pid: root.pid, created: root.created, goneBy: undefined }];
  }

  /** `undefined` when the root is not listed, since then nothing pins its identity. */
  static fromRoot(rootPid: number, listing: WindowsProcessListing): WindowsProcessTree | undefined {
    const root = listing.rows.find(row => row.pid === rootPid);
    if (!root) return undefined;
    const tree = new WindowsProcessTree(root);
    tree.observe(listing);
    return tree;
  }

  /** Record `listing` and return the PIDs of members it still shows running. */
  observe(listing: WindowsProcessListing): number[] {
    for (const member of this.members) {
      if (member.goneBy !== undefined) continue;
      const listed = listing.rows.some(row => this.isMember(row, member));
      if (!listed) member.goneBy = listing.takenAt;
    }

    let grew = true;
    while (grew) {
      grew = false;
      for (const row of listing.rows) {
        if (this.members.some(member => this.isMember(row, member))) continue;
        if (this.members.some(parent => this.isChildOf(row, parent))) {
          this.members.push({ pid: row.pid, created: row.created, goneBy: undefined });
          grew = true;
        }
      }
    }

    return this.members.filter(member => member.goneBy === undefined).map(member => member.pid);
  }

  private isMember(row: WindowsProcessRow, member: TreeMember): boolean {
    return row.pid === member.pid && row.created === member.created;
  }

  private isChildOf(row: WindowsProcessRow, parent: TreeMember): boolean {
    return (
      row.parentPid === parent.pid &&
      row.created >= parent.created &&
      (parent.goneBy === undefined || row.created < parent.goneBy)
    );
  }
}

// Encoded rather than passed through `-Command`, so Windows argument quoting cannot
// alter it. `ProcessId` rows without a `CreationDate` are the kernel's own (Idle,
// System) and cannot belong to a run.
const LIST_PROCESSES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rows = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object {',
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; created = $_.CreationDate.ToUniversalTime().Ticks.ToString() }',
  '})',
  '[pscustomobject]@{ takenAt = [DateTime]::UtcNow.Ticks.ToString(); rows = $rows } | ConvertTo-Json -Compress -Depth 3',
].join('\n');
const LIST_PROCESSES_ENCODED = Buffer.from(LIST_PROCESSES_SCRIPT, 'utf16le').toString('base64');

const TICKS = /^\d+$/;

/** Parse the listing script's JSON. Exported for testing; throws on any other shape. */
export function parseWindowsProcessListing(json: string): WindowsProcessListing {
  const invalid = (): Error => new Error('Windows process listing had an unexpected shape');
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { takenAt, rows } = parsed as { takenAt?: unknown; rows?: unknown };
  if (typeof takenAt !== 'string' || !TICKS.test(takenAt) || !Array.isArray(rows)) throw invalid();
  return {
    takenAt: BigInt(takenAt),
    rows: rows.map((row: unknown): WindowsProcessRow => {
      if (typeof row !== 'object' || row === null) throw invalid();
      const { pid, parentPid, created } = row as Record<string, unknown>;
      if (
        !Number.isInteger(pid) ||
        !Number.isInteger(parentPid) ||
        typeof created !== 'string' ||
        !TICKS.test(created)
      ) {
        throw invalid();
      }
      return { pid: pid as number, parentPid: parentPid as number, created: BigInt(created) };
    }),
  };
}

async function listWindowsProcesses(): Promise<WindowsProcessListing> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', LIST_PROCESSES_ENCODED],
    { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  );
  return parseWindowsProcessListing(stdout);
}

/**
 * Kill `pid`'s process tree and return only once a listing shows no member of it.
 * Throws when that cannot be shown, so the caller leaves the run as it was.
 *
 * `ownsLiveLease` reports whether the owner still holds its termination lease open.
 */
export async function terminateWindowsProcessTree(
  pid: number,
  ownsLiveLease: () => boolean
): Promise<void> {
  const before = await listWindowsProcesses();
  const tree = WindowsProcessTree.fromRoot(pid, before);

  if (!tree) {
    // The root was already gone before the stop, so its identity is unknown and a
    // process naming its PID as parent may belong to an unrelated earlier holder of
    // that PID. Killing on that guess is not allowed; report instead. Neither is
    // `taskkill` on the root PID itself, which may already name another process.
    const claimants = before.rows.filter(row => row.parentPid === pid).map(row => row.pid);
    if (claimants.length > 0) {
      throw new Error(
        `Could not confirm detached workflow process tree ${String(pid)} exited: its root ` +
          `was already gone, and processes ${claimants.join(', ')} name it as their parent`
      );
    }
    return;
  }

  // The owner's lease socket closes when the owner exits, so a lease still open after
  // the listing proves the listed root is the owner and not a later holder of its PID.
  // The first listing can take seconds, which is long enough for the lease to lapse.
  if (!ownsLiveLease()) {
    throw new Error(
      `Detached workflow owner ${String(pid)} released its termination lease before it was stopped`
    );
  }

  // `taskkill /T` does most of the work in one call. Its exit code is not the proof:
  // it is non-zero whenever a member exited during the walk, and zero even when a
  // member spawned during the walk survived it. The listings below are the proof,
  // and a failure is kept only as evidence for the error they may end in.
  let killFailure: string | undefined;
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    killFailure = error instanceof Error ? error.message : String(error);
  }

  let survivors: number[] = [];
  for (let round = 0; round < MAX_CONFIRM_ROUNDS; round++) {
    survivors = tree.observe(await listWindowsProcesses());
    if (survivors.length === 0) return;
    // Every kill is followed by a listing, so the last round only lists.
    if (round === MAX_CONFIRM_ROUNDS - 1) break;
    for (const survivor of survivors) {
      try {
        process.kill(survivor);
      } catch (error) {
        // Gone already is what the next listing checks for; anything else is evidence.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          killFailure = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  throw new Error(
    `Could not confirm detached workflow process tree ${String(pid)} exited: ` +
      `processes ${survivors.join(', ')} are still running` +
      (killFailure ? ` (${killFailure})` : '')
  );
}
