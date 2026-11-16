/**
 * `archon isolation cleanup schedule`: the macOS timer that runs the merged cleanup on an
 * install with no server. A server already sweeps on its own cleanup schedule.
 */
import { createHash } from 'node:crypto';
import { getArchonHome } from '@archon/paths';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { parseIntervalSeconds, validateFlags } from '../utils/command-flags';
import { writeStdout } from '../utils/stdout';
import {
  inspectMacosNativeSchedule,
  installMacosNativeSchedule,
  removeMacosNativeSchedule,
  type NativeScheduleConfig,
} from '../triggers/native-schedule';

/** Six hours. */
export const ISOLATION_CLEANUP_INTERVAL_SECONDS = 21600;

/**
 * One job per install: the id is keyed on the Archon home, and the job runs from it because
 * one pass covers every project registered in that install.
 */
export function isolationCleanupScheduleConfig(
  intervalSeconds = ISOLATION_CLEANUP_INTERVAL_SECONDS,
  env: NodeJS.ProcessEnv = process.env
): NativeScheduleConfig {
  const archonHome = getArchonHome(env);
  return {
    id: `isolation-cleanup-${createHash('sha256').update(archonHome).digest('hex')}`,
    programArguments: [...cliProgramArguments(), 'isolation', 'cleanup', '--merged'],
    workingDirectory: archonHome,
    archonHome,
    path: env.PATH ?? '',
    schedule: { intervalSeconds, runAtLoad: true },
    removeCommand: 'archon isolation cleanup schedule remove',
  };
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

async function install(config: NativeScheduleConfig): Promise<Outcome> {
  const path = await installMacosNativeSchedule(config);
  const every = String(config.schedule.intervalSeconds);
  return {
    result: { path },
    text: `Installed the merged cleanup timer (every ${every}s): ${path}`,
  };
}

async function remove(config: NativeScheduleConfig): Promise<Outcome> {
  const removed = await removeMacosNativeSchedule(config.id);
  return {
    result: { removed },
    text: removed ? 'Removed the merged cleanup timer.' : NOT_INSTALLED,
  };
}

async function status(config: NativeScheduleConfig): Promise<Outcome> {
  const installed = await inspectMacosNativeSchedule(config.id);
  if (!installed) return { result: { installed: false }, text: NOT_INSTALLED };
  const result = { installed: true, ...installed };
  if (installed.registered)
    return { result, text: `The merged cleanup timer is installed: ${installed.path}` };
  return {
    result,
    text:
      `The merged cleanup timer's plist exists but launchd has not loaded it: ${installed.path}. ` +
      `Load it with \`launchctl bootstrap gui/$(id -u) '${installed.path}'\`.`,
  };
}

const OPERATIONS = { install, remove, status } satisfies Record<
  Operation,
  (config: NativeScheduleConfig) => Promise<Outcome>
>;

async function runOperation(operation: Operation, values: Values): Promise<string> {
  validateFlags(values, operation === 'install' ? ['interval'] : []);
  const interval = parseIntervalSeconds(values, ISOLATION_CLEANUP_INTERVAL_SECONDS);
  const { result, text } = await OPERATIONS[operation](isolationCleanupScheduleConfig(interval));
  if (values.json !== true) return text;
  return JSON.stringify({ ok: true, action: `isolation cleanup schedule ${operation}`, ...result });
}

export async function isolationCleanupScheduleCommand(
  args: string[],
  values: Values
): Promise<number> {
  const json = values.json === true;
  const operation = args[0] ?? '';
  try {
    await writeStdout(`${await runOperation(parseOperation(args), values)}\n`);
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
