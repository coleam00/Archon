import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { spyOnJsonStdout } from '../test-support/workflow-harness-output';
import {
  scheduleLabel,
  installNativeSchedule,
  type NativeScheduleOptions,
} from '../triggers/native-schedule';
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

async function invokeResult(
  command: ScheduleCommand,
  operation: Operation,
  schedules: NativeScheduleOptions
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const stdout = spyOnJsonStdout();
  try {
    const exitCode = await command(operation, schedules);
    const printed = stdout.mock.calls.map(([chunk]: readonly unknown[]) => String(chunk)).join('');
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
  return { root, archonHome, alias, schedules, jobFiles };
}

function idForHome(idPrefix: string, archonHome: string): string {
  return `${idPrefix}${createHash('sha256').update(archonHome).digest('hex')}`;
}

async function seedJob(
  schedules: NativeScheduleOptions,
  archonHome: string,
  id: string
): Promise<string> {
  const { path } = await installNativeSchedule(
    {
      id,
      programArguments: id.startsWith('isolation-cleanup-')
        ? [process.execPath, 'isolation', 'cleanup', '--merged']
        : [process.execPath, 'workflow', 'wake', '--watch', '--json'],
      workingDirectory: archonHome,
      archonHome,
      path: '/usr/bin',
      schedule: { intervalSeconds: 5, runAtLoad: true },
      output: 'discard',
      removeCommand: 'archon workflow wake schedule remove',
    },
    schedules
  );
  return path;
}

describe.each(commands)('%s home spelling', (_name, idPrefix, command) => {
  testOnPosixHost(
    'another job family with an unresolvable home does not block schedule operations',
    async () => {
      const { root, archonHome, schedules, jobFiles } = await fixture(idPrefix);
      process.env.ARCHON_HOME = archonHome;
      const installed = await invoke(command, 'install', schedules);
      const otherHome = join(root, 'other-install');
      await mkdir(otherHome);
      const otherPrefix = idPrefix === 'workflow-wake-' ? 'isolation-cleanup-' : 'workflow-wake-';
      const otherPath = await seedJob(schedules, otherHome, idForHome(otherPrefix, otherHome));
      const otherDefinition = await readFile(otherPath);
      await rm(otherHome, { recursive: true });
      await symlink(otherHome, otherHome);

      expect(await invoke(command, 'status', schedules)).toMatchObject({
        installed: true,
        path: installed.path,
      });
      expect(await invoke(command, 'install', schedules)).toMatchObject({ path: installed.path });
      expect(await jobFiles()).toHaveLength(1);
      expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
      expect(await jobFiles()).toEqual([]);
      expect(await readFile(otherPath)).toEqual(otherDefinition);
      expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: false });
    }
  );

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
    const { archonHome, schedules, jobFiles } = await fixture(idPrefix);
    const recordedHome = `${archonHome}${sep}`;
    const legacyId = idForHome(idPrefix, recordedHome);
    const path = await seedJob(schedules, recordedHome, legacyId);
    const lastPass = { at: '2026-11-26T00:00:00.000Z', pid: 1, ok: true, parts: {} };
    const lastPassPath = join(archonHome, 'schedules', `${legacyId}.last-pass.json`);
    const wake = idPrefix === 'workflow-wake-';
    if (wake) {
      await mkdir(join(archonHome, 'schedules'), { recursive: true });
      await writeFile(lastPassPath, JSON.stringify(lastPass));
    }
    process.env.ARCHON_HOME = recordedHome;

    expect(await invoke(command, 'status', schedules)).toMatchObject({
      installed: true,
      path,
      ...(wake ? { lastPass } : {}),
    });
    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
    expect(await jobFiles()).toEqual([]);
    if (wake) await expect(readFile(lastPassPath)).rejects.toMatchObject({ code: 'ENOENT' });
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

  testOnPosixHost(
    'a potentially matching recorded home failure is not successful absence',
    async () => {
      const { archonHome, alias, schedules } = await fixture(idPrefix);
      await seedJob(schedules, alias, idForHome(idPrefix, alias));
      await rm(alias);
      await symlink(alias, alias);
      process.env.ARCHON_HOME = archonHome;

      for (const operation of ['install', 'status', 'remove'] as const) {
        const { exitCode, result } = await invokeResult(command, operation, schedules);
        expect(exitCode).toBe(1);
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('ELOOP') });
      }
    }
  );
});
