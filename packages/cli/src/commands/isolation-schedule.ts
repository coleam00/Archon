/**
 * `archon isolation cleanup schedule`: the OS timer that runs the merged cleanup on an
 * install with no server. A server already sweeps on its own cleanup schedule.
 */
import { createHash } from 'node:crypto';
import { getArchonHome } from '@archon/paths';
import { envPath } from '@archon/paths/env-path';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { parseIntervalSeconds, validateFlags } from '../utils/command-flags';
import { writeStdout } from '../utils/stdout';
import {
  findNativeScheduleTargets,
  inspectNativeScheduleTargets,
  installNativeSchedule,
  removeNativeSchedule,
  type NativeScheduleConfig,
  type NativeScheduleOptions,
  type NativeScheduleTarget,
} from '../triggers/native-schedule';

/** Six hours. */
export const ISOLATION_CLEANUP_INTERVAL_SECONDS = 21600;
const ISOLATION_CLEANUP_ID_PREFIX = 'isolation-cleanup-';

/**
 * One job per install: the id is keyed on the Archon home, and the job runs from it because
 * one pass covers every project registered in that install.
 */
export function isolationCleanupScheduleConfig(
  intervalSeconds = ISOLATION_CLEANUP_INTERVAL_SECONDS,
  env: NodeJS.ProcessEnv = process.env,
  target = isolationCleanupScheduleTarget(env)
): NativeScheduleConfig {
  const { id, archonHome } = target;
  return {
    id,
    programArguments: [...cliProgramArguments(), 'isolation', 'cleanup', '--merged'],
    workingDirectory: archonHome,
    archonHome,
    path: envPath(env) ?? '',
    schedule: { intervalSeconds, runAtLoad: true },
    output: 'log',
    removeCommand: 'archon isolation cleanup schedule remove',
  };
}

function isolationCleanupScheduleTarget(env: NodeJS.ProcessEnv): NativeScheduleTarget {
  const archonHome = getArchonHome(env);
  return {
    id: isolationCleanupScheduleId(archonHome),
    archonHome,
  };
}

function isolationCleanupScheduleId(archonHome: string): string {
  return `${ISOLATION_CLEANUP_ID_PREFIX}${createHash('sha256').update(archonHome).digest('hex')}`;
}

type Values = Record<string, unknown>;
type Operation = 'install' | 'remove' | 'status';

const USAGE =
  'Usage: archon isolation cleanup schedule <install|remove|status> [--interval <seconds>] [--json]';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseOperation(args: string[]): Operation {
  const [operation] = args;
  if (
    args.length !== 1 ||
    (operation !== 'install' && operation !== 'remove' && operation !== 'status')
  ) {
    throw new Error(USAGE);
  }
  return operation;
}

interface Outcome {
  result: Record<string, unknown>;
  text: string;
}

const NOT_INSTALLED = 'No merged cleanup timer is installed.';

async function install(
  interval: number,
  targets: readonly [NativeScheduleTarget, ...NativeScheduleTarget[]],
  schedules: NativeScheduleOptions
): Promise<Outcome> {
  const target =
    targets.length === 1
      ? targets[0]
      : (await inspectNativeScheduleTargets(targets, schedules)).target;
  const config = isolationCleanupScheduleConfig(interval, process.env, target);
  const { path, log } = await installNativeSchedule(config, schedules);
  const every = String(config.schedule.intervalSeconds);
  return {
    result: { path, log },
    text: `Installed the merged cleanup timer (every ${every}s): ${path}`,
  };
}

async function remove(
  targets: readonly NativeScheduleTarget[],
  schedules: NativeScheduleOptions
): Promise<Outcome> {
  let removed = false;
  for (const target of targets) if (await removeNativeSchedule(target, schedules)) removed = true;
  return {
    result: { removed },
    text: removed ? 'Removed the merged cleanup timer.' : NOT_INSTALLED,
  };
}

async function status(
  targets: readonly [NativeScheduleTarget, ...NativeScheduleTarget[]],
  schedules: NativeScheduleOptions
): Promise<Outcome> {
  const { status: installed } = await inspectNativeScheduleTargets(targets, schedules);
  if (installed) {
    const result = { installed: true, ...installed };
    if (!installed.registered)
      return {
        result,
        text:
          `The merged cleanup timer is installed, but the scheduler has not loaded it: ${installed.path}. ` +
          'Install it again with the same --interval to load it, or remove it.',
      };
    const ran = installed.lastRunAt ? `Last ran ${installed.lastRunAt}` : 'It has not run yet';
    return {
      result,
      text: `The merged cleanup timer is installed: ${installed.path}. ${ran} (output: ${installed.log}).`,
    };
  }
  return { result: { installed: false }, text: NOT_INSTALLED };
}

async function runOperation(
  operation: Operation,
  values: Values,
  schedules: NativeScheduleOptions
): Promise<string> {
  validateFlags(values, operation === 'install' ? ['interval'] : []);
  const interval = parseIntervalSeconds(values, ISOLATION_CLEANUP_INTERVAL_SECONDS);
  const archonHome = getArchonHome();
  const targets = await findNativeScheduleTargets(
    archonHome,
    isolationCleanupScheduleId,
    schedules,
    ISOLATION_CLEANUP_ID_PREFIX
  );
  const { result, text } =
    operation === 'install'
      ? await install(interval, targets, schedules)
      : operation === 'remove'
        ? await remove(targets, schedules)
        : await status(targets, schedules);
  if (values.json !== true) return text;
  return JSON.stringify({ ok: true, action: `isolation cleanup schedule ${operation}`, ...result });
}

export async function isolationCleanupScheduleCommand(
  args: string[],
  values: Values,
  schedules: NativeScheduleOptions = {}
): Promise<number> {
  const json = values.json === true;
  const operation = args[0] ?? '';
  try {
    await writeStdout(`${await runOperation(parseOperation(args), values, schedules)}\n`);
    return 0;
  } catch (error) {
    if (json)
      await writeStdout(
        `${JSON.stringify({ ok: false, action: `isolation cleanup schedule ${operation}`.trim(), error: errorMessage(error) })}\n`
      );
    else console.error(errorMessage(error));
    return 1;
  }
}
