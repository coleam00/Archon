/**
 * What `archon trigger check` reads for the bindings without `on`: each such file in the
 * triggers directory, and the config file of each installed `trigger fire` timer of this
 * ARCHON_HOME, wherever it lives. It reads only, and checks each binding by the validation
 * a start of it runs.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { getArchonHome } from '@archon/paths';
import {
  selectStartedWorkflow,
  startedWorkflowInputProblems,
  type SuppliedAtStart,
} from '@archon/core/workflows/binding-workflow';
import { getTriggersPath, type OnBindingFile } from '@archon/core/workflows/run-ended';
import { triggerConfigSchema, type TriggerConfig } from '@archon/workflows/schemas/resource-start';
import {
  discoverBindingWorkflows,
  type BindingDefinitionsDeps,
} from '@archon/core/workflows/definition-source';
import {
  listNativeSchedules,
  type InstalledSchedule,
  type NativeScheduleOptions,
} from './native-schedule';

/** A parsed trigger file `trigger fire` accepts; throws naming what is wrong. */
export function fireConfig(json: unknown): TriggerConfig {
  const value = triggerConfigSchema.safeParse(json);
  if (!value.success)
    throw new Error(
      `Invalid trigger configuration fields: ${value.error.issues.map(issue => issue.path.join('.')).join(', ')}`
    );
  if (!isAbsolute(value.data.binding.launch.cwd))
    throw new Error('Trigger execution cwd must be absolute.');
  return value.data;
}

/** One binding without `on`, as `trigger check` lists it; null where the file cannot say. */
export interface CheckedFireBinding {
  file: string;
  sourceInstanceId: string | null;
  bindingId: string | null;
  hostId: string | null;
  workflowName: string | null;
  cwd: string | null;
  schedule: TriggerConfig['schedule'] | null;
  /** The installed job that fires this file: its definition file, or null when none does. */
  timer: string | null;
  problems: string[];
}

/** A file in the triggers directory or a timer's config: its binding, or why it has none. */
type FireBindingFile = { file: string; timer: string | null } & (
  | { config: TriggerConfig }
  | { problem: string }
);

function readFireConfig(json: unknown): { config: TriggerConfig } | { problem: string } {
  try {
    return { config: fireConfig(json) };
  } catch (error) {
    return { problem: (error as Error).message };
  }
}

/** The files without `on` in the triggers directory. */
async function readDirectoryBindings(): Promise<FireBindingFile[]> {
  const directory = getTriggersPath();
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files: FireBindingFile[] = [];
  for (const name of names) {
    const file = join(directory, name);
    // `readOnBindings` has already read this file as JSON, or the check stopped there.
    const json = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (json !== null && typeof json === 'object' && 'on' in json) continue;
    files.push({ file: resolve(file), timer: null, ...readFireConfig(json) });
  }
  return files;
}

/** The config path of a `trigger fire --config <path>` job, as `schedule install` wrote it. */
function timerConfigPath(programArguments: readonly string[]): string | undefined {
  const fire = programArguments.findIndex(
    (argument, index) => argument === 'trigger' && programArguments[index + 1] === 'fire'
  );
  if (fire === -1) return undefined;
  const flag = programArguments.indexOf('--config', fire + 2);
  const path = flag === -1 ? undefined : programArguments[flag + 1];
  return path === undefined ? undefined : resolve(path);
}

/** Why every tick of a timer fails when its config file cannot be read as a binding. */
function brokenTimer(job: InstalledSchedule, configPath: string, why: string): string {
  return `timer ${job.definition} runs trigger fire --config ${configPath}, which ${why}; every tick fails. Restore the file, or remove the timer by hand: ${job.removeByHand}`;
}

/** A timer's config file, read as `trigger fire` reads it at each tick. */
async function readTimerConfig(
  job: InstalledSchedule,
  configPath: string
): Promise<FireBindingFile> {
  const broken = (why: string) => ({
    file: configPath,
    timer: job.definition,
    problem: brokenTimer(job, configPath, why),
  });
  let json: unknown;
  try {
    json = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  } catch (error) {
    return broken(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'is missing'
        : `is not readable JSON: ${(error as Error).message}`
    );
  }
  const read = readFireConfig(json);
  return 'problem' in read
    ? broken(`is invalid: ${read.problem}`)
    : { file: configPath, timer: job.definition, ...read };
}

/** The directory's bindings, then each installed timer's config not already among them. */
async function readFireBindingFiles(schedules: NativeScheduleOptions): Promise<FireBindingFile[]> {
  const files = await readDirectoryBindings();
  for (const job of await listNativeSchedules(
    getArchonHome(),
    schedules,
    entry => timerConfigPath(entry.programArguments) !== undefined
  )) {
    if ('unreadable' in job) {
      files.push({
        file: job.definition,
        timer: job.definition,
        problem: `${job.unreadable}, so check cannot tell what it runs. Fix it, or remove the job by hand: ${job.removeByHand}`,
      });
      continue;
    }
    const configPath = timerConfigPath(job.programArguments);
    // Not a trigger timer: a workflow wake or isolation cleanup job.
    if (configPath === undefined) continue;
    const listed = files.find(entry => entry.file === configPath);
    if (!listed) files.push(await readTimerConfig(job, configPath));
    else {
      listed.timer = job.definition;
      if ('problem' in listed)
        listed.problem = brokenTimer(job, configPath, `is invalid: ${listed.problem}`);
    }
  }
  return files;
}

async function fireBindingProblems(
  deps: BindingDefinitionsDeps,
  config: TriggerConfig,
  supplied: SuppliedAtStart
): Promise<string[]> {
  const { launch } = config.binding;
  if (!existsSync(launch.cwd))
    return [
      `binding.launch.cwd '${launch.cwd}' does not exist, so this binding never starts; fix the path or remove the file`,
    ];
  // The definitions a start would read, as the run-ended and asks-settled checks judge them.
  const read = await discoverBindingWorkflows(launch, deps);
  if ('refused' in read) return [read.refused];
  return startedWorkflowInputProblems(
    selectStartedWorkflow(launch, read.discovered),
    launch.inputs,
    supplied
  );
}

/**
 * Every binding without `on`, checked as a start of it would be. A timer's job runs
 * `trigger fire --config` alone, with no `--inputs`, so a timer, or a file with `schedule`,
 * must supply every required input itself; a fire-only file may leave one to `--inputs`.
 * `readable` is each binding that could be read, for the reports that read what it starts.
 */
export async function checkFireBindings(
  deps: BindingDefinitionsDeps,
  schedules: NativeScheduleOptions
): Promise<{ checked: CheckedFireBinding[]; readable: OnBindingFile[] }> {
  const checked: CheckedFireBinding[] = [];
  const readable: OnBindingFile[] = [];
  for (const entry of await readFireBindingFiles(schedules)) {
    const base = { file: entry.file, timer: entry.timer };
    if ('problem' in entry) {
      checked.push({
        ...base,
        sourceInstanceId: null,
        bindingId: null,
        hostId: null,
        workflowName: null,
        cwd: null,
        schedule: null,
        problems: [entry.problem],
      });
      continue;
    }
    const { config } = entry;
    const { launch } = config.binding;
    readable.push({
      file: entry.file,
      sourceInstanceId: config.sourceInstanceId,
      binding: config.binding,
    });
    const timer = config.schedule !== undefined || entry.timer !== null;
    checked.push({
      ...base,
      sourceInstanceId: config.sourceInstanceId,
      bindingId: config.binding.bindingId,
      hostId: config.binding.hostId,
      workflowName: launch.workflowName,
      cwd: launch.cwd,
      schedule: config.schedule ?? null,
      problems: await fireBindingProblems(deps, config, timer ? { mapped: [] } : 'at-fire'),
    });
  }
  return { checked, readable };
}
