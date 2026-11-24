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
  nativeScheduleFiles,
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
  /** The job `install` writes: named for, and recording, this install's home identity. */
  target: NativeScheduleTarget;
  /** This binding's installed jobs, each by its definition file. */
  jobs: { target: NativeScheduleTarget; definition: string }[];
  /**
   * What stops a miss from being certain: Archon jobs whose definition is missing or cannot
   * be read, each with how to remove it by hand, or why the jobs could not be listed at all.
   */
  unresolved: string[];
}

/**
 * The binding's installed jobs. A job is named for the install's home identity, the one
 * `listNativeSchedules` compares, and records that home, so every spelling of it (`/x/`,
 * `/x`, a symlink) finds one job, and repointing a symlink later does not move the job.
 * A job installed before that was named for the home as written. It is found by its
 * files under the caller's spelling, and under any other spelling by the home its
 * definition records. The exact names are checked by their files alone, so a job the
 * listing cannot read is still found and removed.
 */
async function triggerScheduleJobs(
  config: TriggerConfig,
  schedules: NativeScheduleOptions
): Promise<TriggerScheduleJobs> {
  const home = getArchonHome();
  const { sourceInstanceId } = config;
  const { bindingId } = config.binding;
  const identity = await archonHomeIdentity(home, schedules.platform ?? process.platform);
  const target = {
    id: triggerScheduleId(identity, sourceInstanceId, bindingId),
    archonHome: identity,
  };
  // No scheduler on this host: nothing can be installed, and `install` says what to run by hand.
  if (nativeScheduleDefinition(target, schedules) === undefined)
    return { target, jobs: [], unresolved: [] };
  const exact = [
    target,
    { id: triggerScheduleId(home, sourceInstanceId, bindingId), archonHome: home },
  ];
  const jobs: TriggerScheduleJobs['jobs'] = [];
  const found = new Set<string>();
  const add = (job: NativeScheduleTarget): void => {
    const label = scheduleLabel(job.id);
    if (found.has(label)) return;
    found.add(label);
    jobs.push({ target: job, definition: nativeScheduleDefinition(job, schedules) ?? label });
  };
  for (const job of exact) if ((await nativeScheduleFiles(job, schedules)).length > 0) add(job);
  let listed: Awaited<ReturnType<typeof listNativeSchedules>>;
  try {
    listed = await listNativeSchedules(home, schedules);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { target, jobs, unresolved: [`the scheduler's jobs cannot be listed: ${reason}`] };
  }
  const unresolved: string[] = [];
  for (const entry of listed) {
    if (found.has(entry.label)) continue;
    if (!('archonHome' in entry)) {
      unresolved.push(`${entry.unreadable} (remove it by hand: ${entry.removeByHand})`);
      continue;
    }
    const legacyId = triggerScheduleId(entry.archonHome, sourceInstanceId, bindingId);
    if (entry.label === scheduleLabel(legacyId))
      add({ id: legacyId, archonHome: entry.archonHome });
  }
  return { target, jobs, unresolved };
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

/** Why a binding with no job found may still have one; empty when the miss is certain. */
function uncertainMiss(unresolved: readonly string[]): string {
  return unresolved.length === 0
    ? ''
    : ` Archon cannot tell whether one of these is this binding's timer: ${unresolved.join('; ')}.`;
}

async function scheduleStatus(
  config: TriggerConfig,
  { jobs, unresolved }: TriggerScheduleJobs,
  schedules: NativeScheduleOptions
): Promise<void> {
  const [first, ...others] = jobs;
  const status = first ? await inspectNativeSchedule(first.target, schedules) : undefined;
  await writeJsonLine({
    bindingId: config.binding.bindingId,
    schedule: 'status',
    ...(status ? { installed: true, ...status } : { installed: false }),
    ...(others.length > 0 ? { duplicates: others.map(job => job.definition) } : {}),
    ...(unresolved.length > 0 ? { unresolved } : {}),
  });
}

async function scheduleRemove(
  config: TriggerConfig,
  { jobs, unresolved }: TriggerScheduleJobs,
  schedules: NativeScheduleOptions
): Promise<void> {
  const bindingId = config.binding.bindingId;
  const removed: string[] = [];
  for (const job of jobs)
    if (await removeNativeSchedule(job.target, schedules)) removed.push(job.definition);
  if (removed.length === 0)
    throw new Error(
      `No timer is installed for binding '${bindingId}' under this ARCHON_HOME.${uncertainMiss(unresolved)}`
    );
  await writeJsonLine({
    bindingId,
    schedule: 'remove',
    removed,
    ...(unresolved.length > 0 ? { unresolved } : {}),
  });
}

async function scheduleInstall(
  config: TimerTriggerConfig,
  configPath: string,
  { target, jobs, unresolved }: TriggerScheduleJobs,
  schedules: NativeScheduleOptions,
  assertKnownRunAsUser: () => Promise<void>
): Promise<void> {
  const bindingId = config.binding.bindingId;
  const older = jobs.filter(job => job.target.id !== target.id);
  if (older.length > 0)
    throw new Error(
      `Binding '${bindingId}' already has a timer installed for this ARCHON_HOME under the name an earlier Archon version gave it: ${older.map(job => job.definition).join(', ')}. ` +
        `Remove it (\`archon trigger schedule remove --config ${configPath}\`), then install again.`
    );
  // A second timer on one binding starts its stage twice per tick, so a possible one refuses.
  if (jobs.length === 0 && unresolved.length > 0)
    throw new Error(
      `Refusing to install a timer for binding '${bindingId}'.${uncertainMiss(unresolved)}`
    );
  await assertKnownRunAsUser();
  const absoluteConfig = resolve(configPath);
  const [executable, ...prefix] = cliProgramArguments();
  await installNativeSchedule(
    {
      id: target.id,
      programArguments: [executable, ...prefix, 'trigger', 'fire', '--config', absoluteConfig],
      workingDirectory: config.binding.launch.cwd,
      archonHome: target.archonHome,
      path: process.env.PATH ?? '',
      schedule: config.schedule,
      output: 'log',
      removeCommand: `archon trigger schedule remove --config ${absoluteConfig}`,
    },
    schedules
  );
  await writeJsonLine({ bindingId, schedule: 'install' });
}
