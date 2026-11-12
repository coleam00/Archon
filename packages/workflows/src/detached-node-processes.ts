import type { ChildProcess } from 'node:child_process';
import { confirmProcessGroupsGone, type ProcessGroupStop } from '@archon/paths/plugin-process';

import { COMPLETED_HOST_COMMAND_WARNING } from './host-command-cleanup';

interface RecordedCommand {
  reaped: boolean;
  child: ChildProcess;
}

export interface PreparedNodeTermination {
  groups: ProcessGroupStop[];
  ready: Promise<string[]>;
  release(): void;
}

/** The parent's exit events are the authority for whether a group can still be signalled. */
export class DetachedNodeProcesses {
  readonly mode = 'detached-posix';
  ended = false;
  private readonly commands = new Map<number, RecordedCommand>();
  private hasStartedCommands = false;
  private preparation: { result: PreparedNodeTermination; settled: Promise<void> } | undefined;

  get held(): boolean {
    return this.preparation !== undefined;
  }

  record(child: ChildProcess): void {
    if (child.pid === undefined) return;
    this.hasStartedCommands = true;
    const pid = child.pid;
    const command: RecordedCommand = { reaped: false, child };
    this.commands.set(pid, command);
    child.once('exit', () => {
      command.reaped = true;
    });
  }

  forget(child: ChildProcess): void {
    if (child.pid !== undefined) this.commands.delete(child.pid);
  }

  async waitForOutput(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + 1000;
    while ([child.stdout, child.stderr].some(stream => stream && !stream.readableEnded)) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    return true;
  }

  signal(pgid: number, signal: NodeJS.Signals): ProcessGroupStop {
    const command = this.commands.get(pgid);
    if (!command) throw new Error('Detached node command is not recorded');
    const group: ProcessGroupStop = command.reaped
      ? { pgid, leaderReaped: true }
      : { pgid, leaderReaped: false };
    if (!group.leaderReaped) {
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        group.signalError = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      }
    }
    return group;
  }

  private signalCommands(): ProcessGroupStop[] {
    return [...this.commands.keys()].map(pgid => this.signal(pgid, 'SIGKILL'));
  }

  prepareTermination(): PreparedNodeTermination {
    if (this.preparation) return this.preparation.result;
    let releaseHold!: () => void;
    const settled = new Promise<void>(resolve => {
      releaseHold = resolve;
    });
    const result: PreparedNodeTermination = {
      groups: this.signalCommands(),
      ready: Promise.all(
        [...this.commands.values()].map(command => this.waitForOutput(command.child))
      ).then(closed => {
        const warnings = closed.every(Boolean)
          ? []
          : [
              "Some process outside the run's process group still holds the node's output; it was not signalled. Find it with lsof on the run's checkout before reusing or removing the checkout.",
            ];
        if (this.hasStartedCommands) {
          warnings.push(COMPLETED_HOST_COMMAND_WARNING);
        }
        return warnings;
      }),
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
