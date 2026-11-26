/**
 * `archon trigger schedule`: the operating system timer that fires one timer binding. The
 * binding's timer is found by the directory `ARCHON_HOME` names, as `trigger check` finds
 * it, so another spelling of the same home reaches the same job.
 */
import { createHash } from 'node:crypto';
import { getArchonHome } from '@archon/paths';
import type { TriggerConfig } from '@archon/workflows/schemas/resource-start';
import {
  findNativeScheduleTargets,
  inspectNativeSchedule,
  installNativeSchedule,
  removeNativeSchedule,
  type NativeScheduleOptions,
  type NativeScheduleTarget,
} from '../triggers/native-schedule';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { writeJsonLine } from '../utils/stdout';

export type ScheduleOperation = 'install' | 'remove' | 'status';

export interface ScheduleRequest {
  operation: ScheduleOperation;
  config: TriggerConfig;
  /** The binding file, absolute: the timer's job runs `trigger fire --config` with it. */
  configPath: string;
  schedules: NativeScheduleOptions;
  /** Install only: refuses a binding whose run-as user this install does not know. */
  assertKnownRunAsUser: () => Promise<void>;
}

/** The id of the binding's timer installed with `ARCHON_HOME` spelled `archonHome`. */
function timerId(archonHome: string, config: TriggerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([archonHome, config.sourceInstanceId, config.binding.bindingId]))
    .digest('hex');
}

export async function scheduleTimer(request: ScheduleRequest): Promise<void> {
  const { operation, config, schedules } = request;
  const archonHome = getArchonHome();
  const targets = await findNativeScheduleTargets(
    archonHome,
    home => timerId(home, config),
    schedules
  );
  const bindingId = config.binding.bindingId;
  if (operation === 'status')
    return writeJsonLine({
      bindingId,
      schedule: operation,
      ...(await timerStatus(targets, schedules)),
    });
  if (operation === 'remove') {
    let removed = false;
    for (const job of targets) if (await removeNativeSchedule(job, schedules)) removed = true;
    return writeJsonLine({ bindingId, schedule: operation, removed });
  }
  // An install under another spelling keeps the found job's, so it renders the same job.
  await installTimer(request, targets[0]);
  await writeJsonLine({ bindingId, schedule: operation });
}

/** Status needs no schedule, so a timer whose file lost its `schedule` can still be read. */
async function timerStatus(
  targets: NativeScheduleTarget[],
  schedules: NativeScheduleOptions
): Promise<Record<string, unknown>> {
  for (const target of targets) {
    const status = await inspectNativeSchedule(target, schedules);
    if (status) return { installed: true, ...status };
  }
  return { installed: false };
}

async function installTimer(request: ScheduleRequest, target: NativeScheduleTarget): Promise<void> {
  const { config, configPath, schedules } = request;
  const bindingId = config.binding.bindingId;
  if (!config.schedule)
    throw new Error(
      `Binding '${bindingId}' is fire-only: its configuration has no schedule, so there is no timer to install. Start it with: archon trigger fire --config ${configPath}`
    );
  await request.assertKnownRunAsUser();
  const [executable, ...prefix] = cliProgramArguments();
  await installNativeSchedule(
    {
      id: target.id,
      programArguments: [executable, ...prefix, 'trigger', 'fire', '--config', configPath],
      workingDirectory: config.binding.launch.cwd,
      archonHome: target.archonHome,
      path: process.env.PATH ?? '',
      schedule: config.schedule,
      output: 'log',
      removeCommand: `archon trigger schedule remove --config ${configPath}`,
    },
    schedules
  );
}
