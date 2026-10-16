import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const windowsProcessCommands = {
  execFile: async (
    command: string,
    args: string[],
    options: Pick<ExecFileOptions, 'timeout' | 'windowsHide' | 'maxBuffer'>
  ) => await execFileAsync(command, args, options),
};

/*
 * Stopping an owned process tree on Windows, and proving it stopped.
 *
 * Windows has no process group to signal, so `taskkill /T` kills the tree it can see
 * when it starts. A descendant spawned while that walk runs survives it. The proof here
 * is the process table itself, read through `Get-CimInstance Win32_Process` as JSON:
 * the stop also rejects orphaned processes whose missing ancestry could hide a member.
 */

/** Upper bound on one `taskkill` or process listing. The first CIM query on a machine can take seconds. */
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * How many listings the stop takes after `taskkill` to confirm the tree exited,
 * before it reports that it could not confirm the tree exited. A bound on attempts, not on
 * time: running out never counts as proof that anything died.
 */
const MAX_CONFIRM_ROUNDS = 5;

/**
 * The longest {@link terminateWindowsProcessTree} runs before it returns or throws: one
 * listing before `taskkill`, `taskkill` itself, then one listing per confirm round, each
 * bounded by its command timeout.
 */
export const WINDOWS_PROCESS_TREE_STOP_MAX_MS = COMMAND_TIMEOUT_MS * (2 + MAX_CONFIRM_ROUNDS);

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

  private constructor(private readonly root: WindowsProcessRow) {
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

  /** Return listed member PIDs; throw if missing ancestry could hide another member. */
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

    this.assertAncestryProved(listing);
    return this.members.filter(member => member.goneBy === undefined).map(member => member.pid);
  }

  /** Missing parents can hide descendants of an intermediate process no listing saw. */
  private assertAncestryProved(listing: WindowsProcessListing): void {
    const ownedUntil = this.members.reduce((latest, member) => {
      const end = member.goneBy ?? listing.takenAt;
      return end > latest ? end : latest;
    }, this.root.created);
    const ambiguous = listing.rows.filter(row => {
      if (row.created < this.root.created || row.created > ownedUntil) return false;
      if (this.members.some(member => this.isMember(row, member))) return false;
      return !listing.rows.some(
        parent => parent.pid === row.parentPid && parent.created <= row.created
      );
    });
    if (ambiguous.length > 0) {
      throw new Error(
        `Could not confirm process tree ${String(this.root.pid)} exited: ` +
          `processes ${ambiguous.map(row => row.pid).join(', ')} have unproved ancestry`
      );
    }
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

export async function listWindowsProcesses(): Promise<WindowsProcessListing> {
  const { stdout } = await windowsProcessCommands.execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', LIST_PROCESSES_ENCODED],
    { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  );
  return parseWindowsProcessListing(stdout);
}

/**
 * Kill `pid`'s process tree and return only when no members or ambiguous orphans remain.
 * Throws when that cannot be shown.
 *
 * `assertRootOwned` must throw if the root exited during the initial listing.
 */
export async function terminateWindowsProcessTree(
  pid: number,
  assertRootOwned: () => void
): Promise<void> {
  const before = await listWindowsProcesses();
  const killFailures: string[] = [];
  if (before.rows.some(row => row.pid === pid)) {
    // The listing can take seconds. A live child handle or owner lease must still
    // pin the root identity. Kill it before ancestry validation can reject cleanup.
    assertRootOwned();

    // taskkill's exit code cannot prove cleanup: a member can exit during its walk
    // or spawn a surviving child. Retain a kill failure if confirmation also fails.
    try {
      await windowsProcessCommands.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      killFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    const tree = WindowsProcessTree.fromRoot(pid, before);
    if (!tree) {
      throw new Error(
        `Could not confirm process tree ${String(pid)} exited: its root was already gone, ` +
          'so descendant ancestry cannot be proved'
      );
    }

    // A listing does not pin a survivor's identity through PID reuse. Another
    // PID-only kill could terminate a process outside the owned tree.
    let survivors: number[] = [];
    for (let round = 0; round < MAX_CONFIRM_ROUNDS; round++) {
      survivors = tree.observe(await listWindowsProcesses());
      if (survivors.length === 0) return;
    }
    throw new Error(
      `Could not confirm process tree ${String(pid)} exited: ` +
        `processes ${survivors.join(', ')} are still running`
    );
  } catch (error) {
    if (killFailures.length === 0) throw error;
    const confirmationFailure = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not terminate process tree ${String(pid)}: ${killFailures.join('; ')}; ${confirmationFailure}`,
      { cause: error }
    );
  }
}
