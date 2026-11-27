/**
 * Native schedules: a timer the operating system owns that runs one Archon command at an
 * interval, as the installing user, with exactly `ARCHON_HOME` and the installing shell's
 * `PATH`. Ownership, idempotency, rollback and status are decided here once; each backend
 * only renders its scheduler's files, reads them back for `trigger check`, and drives its
 * scheduler's CLI.
 */
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { launchdBackend } from './native-schedule-launchd';
import { systemdBackend } from './native-schedule-systemd';
import { taskSchedulerBackend } from './native-schedule-task-scheduler';

const LABEL_PREFIX = 'com.archon.trigger.';

export interface NativeScheduleConfig {
  id: string;
  programArguments: readonly [string, ...string[]];
  workingDirectory: string;
  archonHome: string;
  /** The installing shell's PATH; a scheduler's default PATH lacks bun, gh, and provider CLIs. */
  path: string;
  schedule: {
    intervalSeconds: number;
    /** Also run when the scheduler loads the job: at install and at each login. */
    runAtLoad: boolean;
  };
  /** 'log' appends stdout and stderr to the job's log file; 'discard' drops them. */
  output: 'log' | 'discard';
  /** The command a refused reinstall tells the operator to run; not part of the job. */
  removeCommand: string;
}

/** What status and remove need: they work from a file that no longer has a schedule. */
export type NativeScheduleTarget = Pick<NativeScheduleConfig, 'id' | 'archonHome'>;

/** A validated configuration with the names every backend derives from it. */
export interface ScheduledJob extends NativeScheduleConfig {
  label: string;
  log: string;
}

export interface NativeScheduleStatus {
  /** The job's definition file: the plist, the `.timer` unit, or the task XML. */
  path: string;
  /** The scheduler has the job loaded and will fire it. */
  registered: boolean;
  log: string;
  /** The log's last write; `null` until the job has written to it. */
  lastRunAt: string | null;
}

export type RunCommand = (executable: string, args: readonly string[]) => Promise<void>;

export interface NativeScheduleOptions {
  platform?: NodeJS.Platform;
  runCommand?: RunCommand;
  /** launchd: the user whose GUI domain loads the job. */
  uid?: number;
  launchAgentsDirectory?: string;
  systemdUserDirectory?: string;
  /** Task Scheduler: the principal the task runs as. */
  windowsUserId?: string;
  /** Task Scheduler: the archon command whose `--internal-schedule-launch` the task runs. */
  windowsLauncher?: readonly [string, ...string[]];
}

export interface OwnedFile {
  path: string;
  contents: string | Buffer;
}

/** What a job's command is, read back from the file a backend rendered it into. */
export interface InstalledJob {
  archonHome: string;
  programArguments: string[];
}

/** One installed job, as its files on disk say; `unreadable` when the file is not one a backend wrote. */
export type InstalledSchedule = {
  label: string;
  /** The file the job's command was read from. */
  definition: string;
  /** How to take the job off the scheduler and delete its files by hand. */
  removeByHand: string;
} & (InstalledJob | { unreadable: string });

export interface ScheduleBackend {
  /** The scheduler's name in the unsupported-host answer. */
  scheduler: string;
  /** Every file the job owns; the first is its definition. */
  filePaths(label: string): readonly [string, ...string[]];
  /** The same paths as `filePaths`, in order. Throws for a job the scheduler cannot express. */
  render(job: ScheduledJob): OwnedFile[];
  /** Install only: throws when the scheduler cannot be reached on this host. */
  probe?(): Promise<void>;
  isRegistered(label: string): Promise<boolean>;
  register(job: ScheduledJob): Promise<void>;
  /** A no-op for a job the scheduler has not loaded. */
  unregister(label: string): Promise<void>;
  /** Remove only, after the files are deleted. */
  afterRemove?(): Promise<void>;
  /**
   * Jobs under the Archon prefix whose files are on disk, read back from what `render`
   * wrote. Filters labels before opening definitions; never asks the scheduler.
   */
  installed(matchesLabel?: (label: string) => boolean): Promise<InstalledSchedule[]>;
}

/** No backend can install a timer here; the message says what to schedule by hand when it can. */
export class NativeScheduleUnsupportedError extends Error {
  override name = 'NativeScheduleUnsupportedError';
}

const execFileAsync = promisify(execFile);
const OWNED_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function scheduleLabel(id: string): string {
  if (!OWNED_ID.test(id)) {
    throw new Error(
      'Native schedule id must start and end with a letter or digit and contain only letters, digits, dots, underscores, or hyphens'
    );
  }
  return `${LABEL_PREFIX}${id}`;
}

/**
 * Every platform writes its job's output to the same place, and status reads it from there.
 * The path is joined by the target platform's rules, as the job's other paths are checked.
 */
function scheduleLogPath(
  archonHome: string,
  label: string,
  platform: NodeJS.Platform = process.platform
): string {
  return (platform === 'win32' ? win32 : posix).join(archonHome, 'schedules', `${label}.log`);
}

/** Validates against the target platform's path rules, so Windows jobs validate anywhere. */
export function scheduledJob(
  config: NativeScheduleConfig,
  platform: NodeJS.Platform = process.platform
): ScheduledJob {
  const label = scheduleLabel(config.id);
  const { isAbsolute } = platform === 'win32' ? win32 : posix;
  for (const [name, value] of [
    ['executable', config.programArguments[0]],
    ['working directory', config.workingDirectory],
    ['ARCHON_HOME', config.archonHome],
  ] as const) {
    if (!isAbsolute(value)) throw new Error(`Native schedule ${name} must be an absolute path`);
  }
  if (config.path.length === 0) throw new Error('Native schedule PATH must not be empty');
  if (config.programArguments.some(argument => argument.length === 0)) {
    throw new Error('Native schedule program arguments must not be empty');
  }
  if (
    !Number.isSafeInteger(config.schedule.intervalSeconds) ||
    config.schedule.intervalSeconds <= 0
  ) {
    throw new Error('Native schedule intervalSeconds must be a positive integer');
  }
  return { ...config, label, log: scheduleLogPath(config.archonHome, label, platform) };
}

function defaultRunCommand(): RunCommand {
  return async (executable, args) => {
    await execFileAsync(executable, [...args]);
  };
}

function backendFor(
  platform: NodeJS.Platform,
  archonHome: string,
  options: NativeScheduleOptions
): ScheduleBackend | undefined {
  const run = options.runCommand ?? defaultRunCommand();
  if (platform === 'darwin') return launchdBackend(run, options);
  if (platform === 'linux') return systemdBackend(run, options);
  if (platform === 'win32') return taskSchedulerBackend(run, archonHome, options);
  return undefined;
}

function requireBackend(target: NativeScheduleTarget, options: NativeScheduleOptions) {
  const platform = options.platform ?? process.platform;
  const backend = backendFor(platform, target.archonHome, options);
  if (!backend) {
    throw new NativeScheduleUnsupportedError(
      `This host has no scheduler Archon can manage timers with (platform ${platform}).`
    );
  }
  return backend;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Only POSIX hosts reach this: every Windows host has Task Scheduler. */
function scheduleByHand(job: ScheduledJob, reason: string): NativeScheduleUnsupportedError {
  const command = [
    `cd ${shellQuote(job.workingDirectory)} &&`,
    `ARCHON_HOME=${shellQuote(job.archonHome)}`,
    `PATH=${shellQuote(job.path)}`,
    ...job.programArguments.map(shellQuote),
  ].join(' ');
  return new NativeScheduleUnsupportedError(
    `This host has no scheduler Archon can install a timer with (${reason}). ` +
      `Schedule this command to run every ${String(job.schedule.intervalSeconds)} seconds as this user, by hand:\n  ${command}`
  );
}

/** The labels of the Archon jobs in `directory` whose file ends in `suffix`; none when it is missing. */
export async function installedLabels(directory: string, suffix: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter(name => name.startsWith(LABEL_PREFIX) && name.endsWith(suffix))
    .map(name => name.slice(0, -suffix.length))
    .sort();
}

/** Reads each job's definition with `read`; a file `read` cannot parse is kept, as unreadable. */
export async function readInstalled(
  labels: readonly string[],
  definition: (label: string) => string,
  read: (contents: string) => InstalledJob | undefined,
  removeByHand: (label: string) => string,
  matchesLabel?: (label: string) => boolean
): Promise<InstalledSchedule[]> {
  const installed: InstalledSchedule[] = [];
  for (const label of labels) {
    if (matchesLabel && !matchesLabel(label)) continue;
    const path = definition(label);
    const contents = await readExisting(path);
    // Deleted between the listing and the read: nothing is installed under it any more.
    if (contents === undefined) continue;
    const job = read(contents.toString('utf8'));
    installed.push({
      label,
      definition: path,
      removeByHand: removeByHand(label),
      ...(job ?? { unreadable: `${path} is not a job definition Archon wrote` }),
    });
  }
  return installed;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The installed job differs from the one rendered now, often because PATH changed. */
function differentConfiguration(path: string, removeCommand: string): Error {
  return new Error(
    `Refusing to replace an existing native schedule with different configuration: ${path}. ` +
      "The job records the installing shell's PATH, so a different PATH or an upgrade changes it. " +
      `Remove it (\`${removeCommand}\`), then install it again from the shell whose PATH the job should use.`
  );
}

async function readExisting(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Exclusive create; `false` when an identical file got there first. */
async function createOwnedFile(file: OwnedFile, removeCommand: string): Promise<boolean> {
  const contents = Buffer.from(file.contents);
  const temporaryPath = `${file.path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporaryPath, file.path);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    if (!(await readFile(file.path)).equals(contents)) {
      throw differentConfiguration(file.path, removeCommand);
    }
    return false;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function unlinkAll(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(path => unlink(path).catch(() => undefined)));
}

/**
 * Refuses before writing anything when an existing file differs, then creates the missing
 * ones. Returns the paths this call created, which are the only ones a rollback may delete.
 */
async function writeOwnedFiles(files: OwnedFile[], removeCommand: string): Promise<string[]> {
  const missing: OwnedFile[] = [];
  for (const file of files) {
    const existing = await readExisting(file.path);
    if (existing === undefined) missing.push(file);
    else if (!existing.equals(Buffer.from(file.contents))) {
      throw differentConfiguration(file.path, removeCommand);
    }
  }
  const created: string[] = [];
  try {
    for (const file of missing) {
      if (await createOwnedFile(file, removeCommand)) created.push(file.path);
    }
  } catch (error) {
    await unlinkAll(created);
    throw error;
  }
  return created;
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    if ((await readExisting(path)) !== undefined) found.push(path);
  }
  return found;
}

/**
 * Idempotent: an identical, loaded job is left alone, an identical job the scheduler has not
 * loaded is loaded, and a different one is refused with the remove command.
 */
export async function installNativeSchedule(
  config: NativeScheduleConfig,
  options: NativeScheduleOptions = {}
): Promise<{ path: string; log: string }> {
  const platform = options.platform ?? process.platform;
  const job = scheduledJob(config, platform);
  const backend = backendFor(platform, job.archonHome, options);
  if (!backend) throw scheduleByHand(job, `platform ${platform}`);
  const files = backend.render(job);
  if (backend.probe) {
    try {
      await backend.probe();
    } catch (error) {
      throw scheduleByHand(job, `${backend.scheduler} is not reachable: ${errorMessage(error)}`);
    }
  }

  // Schedulers append to the log but do not create its directory.
  await mkdir(dirname(job.log), { recursive: true, mode: 0o700 });
  for (const file of files) await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
  const created = await writeOwnedFiles(files, config.removeCommand);
  const result = { path: files[0].path, log: job.log };
  if (created.length === 0 && (await backend.isRegistered(job.label))) return result;

  try {
    await backend.register(job);
  } catch (error) {
    await unlinkAll(created);
    throw error;
  }
  return result;
}

type NativeScheduleRegistration = Pick<NativeScheduleStatus, 'path' | 'registered'>;

async function inspectNativeScheduleRegistration(
  target: NativeScheduleTarget,
  options: NativeScheduleOptions = {}
): Promise<NativeScheduleRegistration | undefined> {
  const backend = requireBackend(target, options);
  const label = scheduleLabel(target.id);
  const paths = backend.filePaths(label);
  if ((await existingPaths(paths)).length === 0) return undefined;
  return { path: paths[0], registered: await backend.isRegistered(label) };
}

async function nativeScheduleLogStatus(
  target: NativeScheduleTarget
): Promise<Pick<NativeScheduleStatus, 'log' | 'lastRunAt'>> {
  const log = scheduleLogPath(target.archonHome, scheduleLabel(target.id));
  let lastRunAt: string | null = null;
  try {
    lastRunAt = (await stat(log)).mtime.toISOString();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return { log, lastRunAt };
}

/** `undefined` when none of the job's files exists. */
export async function inspectNativeSchedule(
  target: NativeScheduleTarget,
  options: NativeScheduleOptions = {}
): Promise<NativeScheduleStatus | undefined> {
  const registration = await inspectNativeScheduleRegistration(target, options);
  if (!registration) return undefined;
  return { ...registration, ...(await nativeScheduleLogStatus(target)) };
}

/** Registration selects a watcher without requiring metadata for its discarded output. */
export async function inspectNativeScheduleRegistrationTargets(
  targets: readonly [NativeScheduleTarget, ...NativeScheduleTarget[]],
  options: NativeScheduleOptions = {}
): Promise<{ target: NativeScheduleTarget; status: NativeScheduleRegistration | undefined }> {
  let selectedTarget = targets[0];
  let selectedStatus: NativeScheduleRegistration | undefined;
  for (const target of targets) {
    const status = await inspectNativeScheduleRegistration(target, options);
    if (status?.registered) return { target, status };
    if (status && !selectedStatus) {
      selectedTarget = target;
      selectedStatus = status;
    }
  }
  return { target: selectedTarget, status: selectedStatus };
}

/** Prefers a loaded job, then the first installed job, then the original fallback target. */
export async function inspectNativeScheduleTargets(
  targets: readonly [NativeScheduleTarget, ...NativeScheduleTarget[]],
  options: NativeScheduleOptions = {}
): Promise<{ target: NativeScheduleTarget; status: NativeScheduleStatus | undefined }> {
  const { target, status } = await inspectNativeScheduleRegistrationTargets(targets, options);
  return {
    target,
    status: status ? { ...status, ...(await nativeScheduleLogStatus(target)) } : undefined,
  };
}

/**
 * The file that defines the job, whether or not it exists, without asking the scheduler;
 * `undefined` on a host Archon has no scheduler for.
 */
export function nativeScheduleDefinition(
  target: NativeScheduleTarget,
  options: NativeScheduleOptions = {}
): string | undefined {
  const backend = backendFor(options.platform ?? process.platform, target.archonHome, options);
  return backend?.filePaths(scheduleLabel(target.id))[0];
}

/** Removes the job and the files install created; keeps the log. `false` when not installed. */
export async function removeNativeSchedule(
  target: NativeScheduleTarget,
  options: NativeScheduleOptions = {}
): Promise<boolean> {
  const backend = requireBackend(target, options);
  const label = scheduleLabel(target.id);
  const existing = await existingPaths(backend.filePaths(label));
  if (existing.length === 0) return false;
  await backend.unregister(label);
  for (const path of existing) await unlink(path);
  await backend.afterRemove?.();
  return true;
}

/**
 * The jobs installed for `archonHome`, read from their files, plus any Archon job file that
 * cannot be parsed, whose home is unknown. Labels are filtered before opening definitions;
 * `matchesJob` excludes readable jobs before resolving their homes. None on an unsupported platform.
 */
export async function listNativeSchedules(
  archonHome: string,
  options: NativeScheduleOptions = {},
  matchesJob?: (job: InstalledJob, label: string) => boolean,
  matchesLabel?: (label: string) => boolean
): Promise<InstalledSchedule[]> {
  const platform = options.platform ?? process.platform;
  const backend = backendFor(platform, archonHome, options);
  if (!backend) return [];
  // ARCHON_HOME is taken as written, so another spelling of the same directory (a trailing
  // slash, a symlink) is the same install. Compare the directory, not the text.
  const { resolve } = platform === 'win32' ? win32 : posix;
  // A home that no longer exists has no real path; its resolved text is all there is.
  const identity = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return resolve(path);
      throw error;
    }
  };
  const home = await identity(archonHome);
  const installed: InstalledSchedule[] = [];
  for (const entry of await backend.installed(matchesLabel)) {
    if (!('archonHome' in entry)) {
      installed.push(entry);
      continue;
    }
    if (matchesJob && !matchesJob(entry, entry.label)) continue;
    if ((await identity(entry.archonHome)) === home) installed.push(entry);
  }
  return installed;
}

/**
 * The targets for one logical job in `archonHome`, however that directory was spelled when
 * the job was installed. The id always comes from the home the job file recorded. With no
 * readable match, the current spelling's target still reaches a job file that cannot be read;
 * a distinct current target also stays beside readable matches so removal cannot orphan it.
 */
export async function findNativeScheduleTargets(
  archonHome: string,
  idForHome: (archonHome: string) => string,
  options: NativeScheduleOptions = {},
  idPrefix?: string
): Promise<[NativeScheduleTarget, ...NativeScheduleTarget[]]> {
  const found: NativeScheduleTarget[] = [];
  for (const job of await listNativeSchedules(
    archonHome,
    options,
    (entry, label) => label === scheduleLabel(idForHome(entry.archonHome)),
    idPrefix === undefined ? undefined : label => label.startsWith(`${LABEL_PREFIX}${idPrefix}`)
  )) {
    if (!('archonHome' in job)) continue;
    const id = idForHome(job.archonHome);
    found.push({ id, archonHome: job.archonHome });
  }
  const current = { id: idForHome(archonHome), archonHome };
  const [first, ...rest] = found;
  if (!first) return [current];
  if (found.some(target => target.id === current.id && target.archonHome === current.archonHome))
    return [first, ...rest];
  return [first, ...rest, current];
}
