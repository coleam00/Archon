import type { ChildProcess } from 'node:child_process';
import { confirmProcessGroupsGone, type ProcessGroupStop } from '@archon/paths/plugin-process';

interface RecordedCommand {
  reaped: boolean;
}

export interface PreparedNodeTermination {
  groups: ProcessGroupStop[];
  release(): void;
}

/** The parent's exit events are the authority for whether a group can still be signalled. */
export class DetachedNodeProcesses {
  readonly mode = 'detached-posix';
  ended = false;
  private readonly commands = new Map<number, RecordedCommand>();
  private preparation: { result: PreparedNodeTermination; settled: Promise<void> } | undefined;

  get held(): boolean {
    return this.preparation !== undefined;
  }

  record(child: ChildProcess): void {
    if (child.pid === undefined) return;
    const pid = child.pid;
    const command: RecordedCommand = { reaped: false };
    this.commands.set(pid, command);
    child.once('exit', () => {
      command.reaped = true;
    });
    child.once('close', () => this.commands.delete(pid));
  }

  private signalCommands(): ProcessGroupStop[] {
    return [...this.commands].map(([pgid, command]): ProcessGroupStop => {
      if (command.reaped) return { pgid, leaderReaped: true, signalAttempted: false };
      const group: ProcessGroupStop = { pgid, leaderReaped: false, signalAttempted: true };
      // No await between checking the parent's reap event and the group signal.
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch (error) {
        group.signalError = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      }
      return group;
    });
  }

  prepareTermination(): PreparedNodeTermination {
    if (this.preparation) return this.preparation.result;
    let releaseHold!: () => void;
    const settled = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    const result: PreparedNodeTermination = {
      groups: this.signalCommands(),
      release: () => {
        if (this.preparation?.result !== result) return;
        this.preparation = undefined;
        releaseHold();
      },
    };
    this.preparation = { result, settled };
    return result;
  }

  async waitForRelease(): Promise<void> {
    while (this.preparation) await this.preparation.settled;
  }

  async end(): Promise<void> {
    this.ended = true;
    const groups = this.preparation?.result.groups ?? this.signalCommands();
    await confirmProcessGroupsGone(
      groups.map(group => group.pgid),
      1000
    );
  }
}
