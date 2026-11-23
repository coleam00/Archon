/**
 * `archon workflow wake schedule`: the OS job that keeps `archon workflow wake --watch`
 * running on an install with no server, so its observing sources are read.
 *
 * The job is an ordinary native schedule, not a long-lived service. Every backend starts
 * the command on an interval and never starts a second copy while one runs: launchd by its
 * own rule, systemd because a timer cannot start a `oneshot` unit that is still activating,
 * and Task Scheduler by `IgnoreNew` (the schedule launcher waits for the wrapper, so the
 * task instance lasts as long as the watcher). So the interval is how soon a watcher that
 * exited, for any reason, is started again.
 */
import { createHash } from 'node:crypto';
import { getArchonHome } from '@archon/paths';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { parseIntervalSeconds, validateFlags } from '../utils/command-flags';
import { writeStdout } from '../utils/stdout';
import {
  inspectNativeSchedule,
  installNativeSchedule,
  removeNativeSchedule,
  type NativeScheduleConfig,
  type NativeScheduleTarget,
} from '../triggers/native-schedule';

export const WAKE_SCHEDULE_INSTALL_COMMAND = 'archon workflow wake schedule install';

/** Task Scheduler repeats a task in whole minutes only, from one minute. */
export function defaultWakeIntervalSeconds(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 60 : 5;
}

/** One job per install: the id is keyed on the Archon home. */
export function workflowWakeScheduleTarget(): NativeScheduleTarget {
  const archonHome = getArchonHome();
  return {
    id: `workflow-wake-${createHash('sha256').update(archonHome).digest('hex')}`,
    archonHome,
  };
}

export function workflowWakeScheduleConfig(
  intervalSeconds = defaultWakeIntervalSeconds()
): NativeScheduleConfig {
  const { id, archonHome } = workflowWakeScheduleTarget();
  const [executable, ...prefix] = cliProgramArguments();
  return {
    id,
    programArguments: [executable, ...prefix, 'workflow', 'wake', '--watch', '--json'],
    workingDirectory: archonHome,
    archonHome,
    path: process.env.PATH ?? '',
    schedule: { intervalSeconds, runAtLoad: true },
    // A watcher writes a line every pass, forever; a log of it would only grow.
    output: 'discard',
    removeCommand: 'archon workflow wake schedule remove',
  };
}

type Values = Record<string, unknown>;
type Operation = 'install' | 'remove' | 'status';

const USAGE =
  'Usage: archon workflow wake schedule <install|remove|status> [--interval <seconds>] [--json]';
const NOT_INSTALLED = 'No wake watcher job is installed.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Outcome {
  result: Record<string, unknown>;
  text: string;
}

async function install(config: NativeScheduleConfig): Promise<Outcome> {
  const { path } = await installNativeSchedule(config);
  const every = String(config.schedule.intervalSeconds);
  return {
    result: { path },
    text: `Installed the wake watcher job (restarted within ${every}s when it exits): ${path}`,
  };
}

async function remove(config: NativeScheduleConfig): Promise<Outcome> {
  const removed = await removeNativeSchedule(config);
  return {
    result: { removed },
    text: removed ? 'Removed the wake watcher job.' : NOT_INSTALLED,
  };
}

async function status(config: NativeScheduleConfig): Promise<Outcome> {
  const installed = await inspectNativeSchedule(config);
  if (!installed) return { result: { installed: false }, text: NOT_INSTALLED };
  const result = { installed: true, path: installed.path, registered: installed.registered };
  if (!installed.registered)
    return {
      result,
      text:
        `The wake watcher job is installed, but the scheduler has not loaded it: ${installed.path}. ` +
        'Install it again with the same --interval to load it, or remove it.',
    };
  return { result, text: `The wake watcher job is installed: ${installed.path}.` };
}

const OPERATIONS = { install, remove, status } satisfies Record<
  Operation,
  (config: NativeScheduleConfig) => Promise<Outcome>
>;

function parseOperation(args: string[]): Operation {
  const operation = args[1];
  if (
    args.length !== 2 ||
    (operation !== 'install' && operation !== 'remove' && operation !== 'status')
  )
    throw new Error(USAGE);
  return operation;
}

/** `args` starts at `schedule`. */
export async function workflowWakeScheduleCommand(args: string[], values: Values): Promise<number> {
  const json = values.json === true;
  try {
    const operation = parseOperation(args);
    validateFlags(values, operation === 'install' ? ['interval'] : []);
    const config = workflowWakeScheduleConfig(
      parseIntervalSeconds(values, defaultWakeIntervalSeconds())
    );
    const { result, text } = await OPERATIONS[operation](config);
    await writeStdout(
      json
        ? `${JSON.stringify({ ok: true, action: `wake schedule ${operation}`, ...result })}\n`
        : `${text}\n`
    );
    return 0;
  } catch (error) {
    if (json)
      await writeStdout(
        `${JSON.stringify({ ok: false, action: 'wake', signaled: false, error: errorMessage(error) })}\n`
      );
    else console.error(errorMessage(error));
    return 1;
  }
}
