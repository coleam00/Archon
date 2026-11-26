import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { NativeScheduleOptions } from '../triggers/native-schedule';
import { isolationCleanupScheduleCommand } from './isolation-schedule';
import { workflowWakeScheduleCommand } from './wake-schedule';

const trackTempRoot = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
const testOnPosixHost = test.skipIf(process.platform === 'win32');

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

type Operation = 'install' | 'remove' | 'status';
type ScheduleCommand = (operation: Operation, schedules: NativeScheduleOptions) => Promise<number>;

const commands = [
  [
    'wake watcher',
    'workflow-wake-',
    (operation: Operation, schedules: NativeScheduleOptions) =>
      workflowWakeScheduleCommand(['schedule', operation], { json: true }, schedules),
  ],
  [
    'merged cleanup timer',
    'isolation-cleanup-',
    (operation: Operation, schedules: NativeScheduleOptions) =>
      isolationCleanupScheduleCommand([operation], { json: true }, schedules),
  ],
] as const;

async function invoke(
  command: ScheduleCommand,
  operation: Operation,
  schedules: NativeScheduleOptions
): Promise<Record<string, unknown>> {
  let printed = '';
  const stdout = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: () => void
  ) => {
    printed += String(chunk);
    (typeof encodingOrCallback === 'function' ? (encodingOrCallback as () => void) : callback)?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    expect(await command(operation, schedules)).toBe(0);
  } finally {
    stdout.mockRestore();
  }
  return JSON.parse(printed) as Record<string, unknown>;
}

async function fixture(idPrefix: string) {
  const root = trackTempRoot(
    await realpath(await mkdtemp(join(tmpdir(), 'archon-schedule-home-spelling-')))
  );
  const archonHome = join(root, 'home');
  await mkdir(archonHome);
  const alias = join(root, 'home-link');
  await symlink(archonHome, alias, 'junction');
  const launchAgentsDirectory = join(root, 'LaunchAgents');
  const schedules: NativeScheduleOptions = {
    platform: 'darwin',
    uid: 501,
    launchAgentsDirectory,
    runCommand: async () => undefined,
  };
  const jobFiles = async (): Promise<string[]> => {
    try {
      return (await readdir(launchAgentsDirectory))
        .filter(name => name.startsWith(`com.archon.trigger.${idPrefix}`))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return { archonHome, alias, schedules, jobFiles };
}

describe.each(commands)('%s home spelling', (_name, idPrefix, command) => {
  testOnPosixHost('status and remove find the job installed under another spelling', async () => {
    const { archonHome, alias, schedules, jobFiles } = await fixture(idPrefix);
    process.env.ARCHON_HOME = `${archonHome}${sep}`;
    const installed = await invoke(command, 'install', schedules);
    expect(await jobFiles()).toHaveLength(1);

    process.env.ARCHON_HOME = archonHome;
    expect(await invoke(command, 'status', schedules)).toMatchObject({
      installed: true,
      path: installed.path,
    });
    process.env.ARCHON_HOME = alias;
    expect(await invoke(command, 'status', schedules)).toMatchObject({
      installed: true,
      path: installed.path,
    });
    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
    expect(await jobFiles()).toEqual([]);

    expect(await invoke(command, 'status', schedules)).toMatchObject({ installed: false });
    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: false });
  });

  testOnPosixHost('install under another spelling keeps one job', async () => {
    const { archonHome, alias, schedules, jobFiles } = await fixture(idPrefix);
    process.env.ARCHON_HOME = `${archonHome}${sep}`;
    const installed = await invoke(command, 'install', schedules);
    const files = await jobFiles();

    for (const spelling of [archonHome, alias, `${archonHome}${sep}`]) {
      process.env.ARCHON_HOME = spelling;
      expect(await invoke(command, 'install', schedules)).toMatchObject({
        path: installed.path,
      });
      expect(await jobFiles()).toEqual(files);
    }
  });
});
