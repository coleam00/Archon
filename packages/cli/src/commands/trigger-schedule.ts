/**
 * `archon trigger schedule <install|remove|status>`: the operating system timer that fires a
 * timer binding, named for the install and binding it belongs to.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getArchonHome } from '@archon/paths';
import type { TriggerConfig } from '@archon/workflows/schemas/resource-start';
import {
  archonHomeIdentity,
  inspectNativeSchedule,
  installNativeSchedule,
  listNativeSchedules,
  nativeScheduleDefinition,
  removeNativeSchedule,
  scheduleLabel,
  type NativeScheduleOptions,
  type NativeScheduleTarget,
} from '../triggers/native-schedule';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { writeJsonLine } from '../utils/stdout';

export type ScheduleOperation = 'install' | 'remove' | 'status';

export function isScheduleOperation(value: string | undefined): value is ScheduleOperation {
  return value === 'install' || value === 'remove' || value === 'status';
}

/** A configuration a clock can start. One without `schedule` is fire-only and is not this. */
type TimerTriggerConfig = TriggerConfig & {
  schedule: NonNullable<TriggerConfig['schedule']>;
};

function isTimerConfig(config: TriggerConfig): config is TimerTriggerConfig {
  return config.schedule !== undefined;
}

function triggerScheduleId(
  archonHome: string,
  sourceInstanceId: string,
  bindingId: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([archonHome, sourceInstanceId, bindingId]))
    .digest('hex');
}

interface TriggerScheduleJobs {
  /** The id `install` writes: every spelling of this install's home computes the same one. */
  id: string;
  jobs: { target: NativeScheduleTarget; definition: string }[];
  /** Archon job definitions that could not be read, so they may belong to this binding. */
  unreadable: string[];
}

/**
 * The binding's installed jobs. A job is named for the install's home identity, the one
 * `listNativeSchedules` compares, so `/x/`, `/x` and a symlink to it compute one id. A job
 * installed before that was named for the home as written: it is found directly under the
 * caller's spelling, and under any other spelling by the home its definition records. The
 * direct ids go through `inspectNativeSchedule`, which counts a job by any file it owns, so
 * a job missing a companion file is still found.
 */
async function triggerScheduleJobs(
  config: TriggerConfig,
  schedules: NativeScheduleOptions
): Promise<TriggerScheduleJobs> {
  const home = getArchonHome();
  const { sourceInstanceId } = config;
  const { bindingId } = config.binding;
  const id = triggerScheduleId(
    await archonHomeIdentity(home, schedules.platform ?? process.platform),
    sourceInstanceId,
    bindingId
  );
  // No scheduler on this host: nothing can be installed, and `install` says what to run by hand.
  if (nativeScheduleDefinition({ id, archonHome: home }, schedules) === undefined)
    return { id, jobs: [], unreadable: [] };
  const jobs: TriggerScheduleJobs['jobs'] = [];
  for (const directId of new Set([id, triggerScheduleId(home, sourceInstanceId, bindingId)])) {
    const target = { id: directId, archonHome: home };
    const status = await inspectNativeSchedule(target, schedules);
    if (status) jobs.push({ target, definition: status.path });
  }
  const found = new Set(jobs.map(job => scheduleLabel(job.target.id)));
  const unreadable: string[] = [];
  for (const entry of await listNativeSchedules(home, schedules)) {
    if (found.has(entry.label)) continue;
    if (!('archonHome' in entry)) {
      unreadable.push(entry.definition);
      continue;
    }
    const legacyId = triggerScheduleId(entry.archonHome, sourceInstanceId, bindingId);
    if (entry.label === scheduleLabel(legacyId))
      jobs.push({
        target: { id: legacyId, archonHome: entry.archonHome },
        definition: entry.definition,
      });
  }
  return { id, jobs, unreadable };
}

/**
 * Remove and status need no schedule, so a timer installed before the file lost its
 * `schedule` can still be inspected and removed.
 */
export async function scheduleTrigger(
  operation: ScheduleOperation,
  configPath: string,
  config: TriggerConfig,
  schedules: NativeScheduleOptions,
  assertKnownRunAsUser: () => Promise<void>
): Promise<void> {
  const found = await triggerScheduleJobs(config, schedules);
  if (operation === 'status') return scheduleStatus(config, found, schedules);
  if (operation === 'remove') return scheduleRemove(config, found, schedules);
  if (!isTimerConfig(config))
    throw new Error(
      `Binding '${config.binding.bindingId}' is fire-only: its configuration has no schedule, so there is no timer to install. Start it with: archon trigger fire --config ${configPath}`
    );
  return scheduleInstall(config, configPath, found, schedules, assertKnownRunAsUser);
}

async function scheduleStatus(
  config: TriggerConfig,
  { jobs }: TriggerScheduleJobs,
  schedules: NativeScheduleOptions
): Promise<void> {
  const [first, ...others] = jobs;
  const status = first ? await inspectNativeSchedule(first.target, schedules) : undefined;
  await writeJsonLine({
    bindingId: config.binding.bindingId,
    schedule: 'status',
    ...(status ? { installed: true, ...status } : { installed: false }),
    ...(others.length > 0 ? { duplicates: others.map(job => job.definition) } : {}),
  });
}

async function scheduleRemove(
  config: TriggerConfig,
  { jobs }: TriggerScheduleJobs,
  schedules: NativeScheduleOptions
): Promise<void> {
  const bindingId = config.binding.bindingId;
  const removed: string[] = [];
  for (const job of jobs)
    if (await removeNativeSchedule(job.target, schedules)) removed.push(job.definition);
  if (removed.length === 0)
    throw new Error(`No timer is installed for binding '${bindingId}' under this ARCHON_HOME.`);
  await writeJsonLine({ bindingId, schedule: 'remove', removed });
}

async function scheduleInstall(
  config: TimerTriggerConfig,
  configPath: string,
  { id, jobs, unreadable }: TriggerScheduleJobs,
  schedules: NativeScheduleOptions,
  assertKnownRunAsUser: () => Promise<void>
): Promise<void> {
  const bindingId = config.binding.bindingId;
  const older = jobs.filter(job => job.target.id !== id);
  if (older.length > 0)
    throw new Error(
      `Binding '${bindingId}' already has a timer installed for this ARCHON_HOME under the name an earlier Archon version gave it: ${older.map(job => job.definition).join(', ')}. ` +
        `Remove it (\`archon trigger schedule remove --config ${configPath}\`), then install again.`
    );
  await assertKnownRunAsUser();
  const absoluteConfig = resolve(configPath);
  const [executable, ...prefix] = cliProgramArguments();
  await installNativeSchedule(
    {
      id,
      programArguments: [executable, ...prefix, 'trigger', 'fire', '--config', absoluteConfig],
      workingDirectory: config.binding.launch.cwd,
      archonHome: getArchonHome(),
      path: process.env.PATH ?? '',
      schedule: config.schedule,
      output: 'log',
      removeCommand: `archon trigger schedule remove --config ${absoluteConfig}`,
    },
    schedules
  );
  await writeJsonLine({
    bindingId,
    schedule: 'install',
    ...(unreadable.length > 0 ? { unreadable } : {}),
  });
}
