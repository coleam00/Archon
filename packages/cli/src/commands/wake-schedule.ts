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
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  readWakeLastPass,
  wakeJobId,
  wakeLastPassPath,
  type WakeLastPass,
} from '@archon/core/workflows/wake-last-pass';
import { getArchonHome } from '@archon/paths';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { parseIntervalSeconds, validateFlags } from '../utils/command-flags';
import { writeStdout } from '../utils/stdout';
import {
  findNativeScheduleTargets,
  inspectNativeScheduleRegistrationTargets,
  inspectNativeScheduleTargets,
  installNativeSchedule,
  removeNativeSchedule,
  type NativeScheduleConfig,
  type NativeScheduleOptions,
  type NativeScheduleTarget,
} from '../triggers/native-schedule';

export const WAKE_SCHEDULE_INSTALL_COMMAND = 'archon workflow wake schedule install';
const WAKE_SCHEDULE_ID_PREFIX = 'workflow-wake-';

/** Task Scheduler repeats a task in whole minutes only, from one minute. */
export function defaultWakeIntervalSeconds(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 60 : 5;
}

/** One job per install: the id is keyed on the Archon home. */
export function workflowWakeScheduleTarget(archonHome = getArchonHome()): NativeScheduleTarget {
  return { id: wakeJobId(archonHome), archonHome };
}

export async function workflowWakeScheduleTargets(
  schedules: NativeScheduleOptions = {}
): Promise<[NativeScheduleTarget, ...NativeScheduleTarget[]]> {
  const archonHome = getArchonHome();
  return findNativeScheduleTargets(
    archonHome,
    home => workflowWakeScheduleTarget(home).id,
    schedules,
    WAKE_SCHEDULE_ID_PREFIX
  );
}

/**
 * Whether the install's own env file sets ARCHON_WEBHOOK_SOURCES. The watch the job starts
 * reads that file, so the job needs no `--sources` of its own, and a job installed that way
 * renders exactly as it did before `--sources` existed.
 */
function homeEnvNamesSources(archonHome: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(join(archonHome, '.env'), 'utf8');
  } catch {
    return false;
  }
  return /^\s*(?:export\s+)?ARCHON_WEBHOOK_SOURCES\s*=\s*\S/m.test(contents);
}

export function workflowWakeScheduleConfig(
  intervalSeconds = defaultWakeIntervalSeconds(),
  target = workflowWakeScheduleTarget()
): NativeScheduleConfig {
  const { id, archonHome } = target;
  const [executable, ...prefix] = cliProgramArguments();
  // The job sets only ARCHON_HOME and PATH, so a sources file only this shell names travels
  // as an argument. Otherwise the job could read it only from ARCHON_HOME/.env, which every
  // process on the install loads, a server included, and which wins over a process's own
  // environment, so a server sharing the home could not leave observing to the job.
  const sources = homeEnvNamesSources(archonHome)
    ? undefined
    : process.env.ARCHON_WEBHOOK_SOURCES?.trim();
  return {
    id,
    programArguments: [
      executable,
      ...prefix,
      'workflow',
      'wake',
      '--watch',
      '--json',
      ...(sources ? ['--sources', resolve(sources)] : []),
    ],
    workingDirectory: archonHome,
    archonHome,
    path: process.env.PATH ?? '',
    schedule: { intervalSeconds, runAtLoad: true },
    // A watcher writes a line every pass, forever; a log of it would only grow.
    output: 'discard',
    removeCommand: 'archon workflow wake schedule remove',
  };
}

const failureText = (errors: readonly string[]): string =>
  errors.join('; ') || 'run archon workflow wake --json to see why';

/** For an operator: when the last pass ran, and when and why this watcher last failed one. */
export function describeWakeLastPass(pass: WakeLastPass): string {
  const last = pass.ok
    ? `Its last pass, at ${pass.at}, succeeded.`
    : `Its last pass, at ${pass.at}, failed: ${failureText(
        Object.values(pass.parts).flatMap(part =>
          part === undefined || part.ok ? [] : part.errors
        )
      )}.`;
  if (pass.ok && pass.lastFailure)
    return `${last} It failed a pass at ${pass.lastFailure.at}: ${failureText(pass.lastFailure.errors)}. A start that pass could not record may not be tried again until the watcher restarts.`;
  return last;
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

async function install(
  interval: number,
  targets: readonly [NativeScheduleTarget, ...NativeScheduleTarget[]],
  schedules: NativeScheduleOptions
): Promise<Outcome> {
  const target =
    targets.length === 1
      ? targets[0]
      : (await inspectNativeScheduleRegistrationTargets(targets, schedules)).target;
  const config = workflowWakeScheduleConfig(interval, target);
  const { path } = await installNativeSchedule(config, schedules);
  const every = String(config.schedule.intervalSeconds);
  return {
    result: { path },
    text: `Installed the wake watcher job (restarted within ${every}s when it exits): ${path}`,
  };
}

async function remove(
  targets: readonly NativeScheduleTarget[],
  schedules: NativeScheduleOptions
): Promise<Outcome> {
  let removed = false;
  for (const target of targets) {
    if (await removeNativeSchedule(target, schedules)) removed = true;
    await unlink(wakeLastPassPath(target)).catch(() => undefined);
  }
  return {
    result: { removed },
    text: removed ? 'Removed the wake watcher job.' : NOT_INSTALLED,
  };
}

async function status(
  targets: readonly [NativeScheduleTarget, ...NativeScheduleTarget[]],
  schedules: NativeScheduleOptions
): Promise<Outcome> {
  const { target, status: installed } = await inspectNativeScheduleTargets(targets, schedules);
  if (!installed) return { result: { installed: false }, text: NOT_INSTALLED };
  const passPath = wakeLastPassPath(target);
  const recorded = await readWakeLastPass(passPath);
  const lastPass = recorded.kind === 'read' ? recorded.pass : undefined;
  const result = {
    installed: true,
    path: installed.path,
    registered: installed.registered,
    ...(lastPass ? { lastPass } : {}),
    ...(recorded.kind === 'unreadable' ? { lastPassUnreadable: recorded.reason } : {}),
  };
  if (!installed.registered)
    return {
      result,
      text:
        `The wake watcher job is installed, but the scheduler has not loaded it: ${installed.path}. ` +
        'Install it again with the same --interval to load it, or remove it.',
    };
  const last =
    recorded.kind === 'unreadable'
      ? ` Its last-pass record ${passPath} could not be read: ${recorded.reason}`
      : lastPass
        ? ` ${describeWakeLastPass(lastPass)}`
        : ' No watcher has recorded a pass yet.';
  return { result, text: `The wake watcher job is installed: ${installed.path}.${last}` };
}

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
export async function workflowWakeScheduleCommand(
  args: string[],
  values: Values,
  schedules: NativeScheduleOptions = {}
): Promise<number> {
  const json = values.json === true;
  try {
    const operation = parseOperation(args);
    validateFlags(values, operation === 'install' ? ['interval'] : []);
    const interval = parseIntervalSeconds(values, defaultWakeIntervalSeconds());
    const targets = await workflowWakeScheduleTargets(schedules);
    const { result, text } =
      operation === 'install'
        ? await install(interval, targets, schedules)
        : operation === 'remove'
          ? await remove(targets, schedules)
          : await status(targets, schedules);
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
