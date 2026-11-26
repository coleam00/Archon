import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  scheduleLabel,
  scheduledJob,
  type NativeScheduleOptions,
} from '../triggers/native-schedule';
import { renderMacosLaunchAgent } from '../triggers/native-schedule-launchd';
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
    'workflow-wake-1e14189f615b2caa1617df692c9491f02d52515620207167d960b8534e131b94',
  ],
  [
    'merged cleanup timer',
    'isolation-cleanup-',
    (operation: Operation, schedules: NativeScheduleOptions) =>
      isolationCleanupScheduleCommand([operation], { json: true }, schedules),
    'isolation-cleanup-1e14189f615b2caa1617df692c9491f02d52515620207167d960b8534e131b94',
  ],
] as const;

async function invokeResult(
  command: ScheduleCommand,
  operation: Operation,
  schedules: NativeScheduleOptions
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
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
    const exitCode = await command(operation, schedules);
    return { exitCode, result: JSON.parse(printed) as Record<string, unknown> };
  } finally {
    stdout.mockRestore();
  }
}

async function invoke(
  command: ScheduleCommand,
  operation: Operation,
  schedules: NativeScheduleOptions
): Promise<Record<string, unknown>> {
  const { exitCode, result } = await invokeResult(command, operation, schedules);
  expect(exitCode).toBe(0);
  return result;
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

function idForHome(idPrefix: string, archonHome: string): string {
  return `${idPrefix}${createHash('sha256').update(archonHome).digest('hex')}`;
}

async function seedJob(
  schedules: NativeScheduleOptions,
  archonHome: string,
  id: string
): Promise<string> {
  const job = scheduledJob(
    {
      id,
      programArguments: [process.execPath, 'workflow', 'wake', '--watch', '--json'],
      workingDirectory: archonHome,
      archonHome,
      path: '/usr/bin',
      schedule: { intervalSeconds: 5, runAtLoad: true },
      output: 'discard',
      removeCommand: 'archon workflow wake schedule remove',
    },
    'darwin'
  );
  const path = join(schedules.launchAgentsDirectory!, `${job.label}.plist`);
  await mkdir(schedules.launchAgentsDirectory!, { recursive: true });
  await writeFile(path, renderMacosLaunchAgent(job));
  return path;
}

describe.each(commands)('%s home spelling', (_name, idPrefix, command, legacyId) => {
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

  testOnPosixHost('status and remove reach an id written before this change', async () => {
    const { schedules, jobFiles } = await fixture(idPrefix);
    const recordedHome = '/tmp/archon-legacy-home/';
    const path = await seedJob(schedules, recordedHome, legacyId);
    process.env.ARCHON_HOME = recordedHome;

    expect(await invoke(command, 'status', schedules)).toMatchObject({ installed: true, path });
    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
    expect(await jobFiles()).toEqual([]);
  });

  testOnPosixHost('remove deletes every matching readable job', async () => {
    const { archonHome, alias, schedules, jobFiles } = await fixture(idPrefix);
    await seedJob(schedules, `${archonHome}${sep}`, idForHome(idPrefix, `${archonHome}${sep}`));
    await seedJob(schedules, archonHome, idForHome(idPrefix, archonHome));
    expect(await jobFiles()).toHaveLength(2);
    process.env.ARCHON_HOME = alias;

    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
    expect(await jobFiles()).toEqual([]);
  });

  testOnPosixHost('remove keeps the current target beside a readable alternate', async () => {
    const { archonHome, schedules, jobFiles } = await fixture(idPrefix);
    await seedJob(schedules, `${archonHome}${sep}`, idForHome(idPrefix, `${archonHome}${sep}`));
    const currentId = idForHome(idPrefix, archonHome);
    await writeFile(
      join(schedules.launchAgentsDirectory!, `${scheduleLabel(currentId)}.plist`),
      '<plist/>'
    );
    process.env.ARCHON_HOME = archonHome;

    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
    expect(await jobFiles()).toEqual([]);
  });

  testOnPosixHost('home canonicalization failure is not successful absence', async () => {
    const { archonHome, schedules } = await fixture(idPrefix);
    const loop = `${archonHome}-loop`;
    await symlink(loop, loop);
    process.env.ARCHON_HOME = loop;

    for (const operation of ['install', 'status', 'remove'] as const) {
      const { exitCode, result } = await invokeResult(command, operation, schedules);
      expect(exitCode).toBe(1);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ELOOP') });
    }
  });
});
