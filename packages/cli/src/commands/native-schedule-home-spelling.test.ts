import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { spyOnJsonStdout } from '../test-support/workflow-harness-output';
import {
  scheduleLabel,
  installNativeSchedule,
  type NativeScheduleOptions,
} from '../triggers/native-schedule';
import {
  isolationCleanupScheduleCommand,
  isolationCleanupScheduleConfig,
} from './isolation-schedule';
import { workflowWakeScheduleCommand, workflowWakeScheduleConfig } from './wake-schedule';

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
  testOnPosixHost.each(['darwin', 'linux'] as const)(
    '%s malformed alternate definitions refuse every operation without deleting or duplicating jobs',
    async platform => {
      const { root, archonHome, schedules } = await fixture(idPrefix);
      schedules.platform = platform;
      schedules.systemdUserDirectory = join(root, 'units');
      const recordedHome = `${archonHome}${sep}`;
      const installed = await seedJob(schedules, recordedHome, idForHome(idPrefix, recordedHome));
      const definition =
        platform === 'linux' ? installed.replace(/\.timer$/, '.service') : installed;
      await writeFile(definition, 'malformed definition');
      process.env.ARCHON_HOME = archonHome;

      for (const readableMatch of [false, true]) {
        if (readableMatch) await seedJob(schedules, archonHome, idForHome(idPrefix, archonHome));
        const files = (await readdir(dirname(installed))).sort();
        const contents = await Promise.all(
          files.map(file => readFile(join(dirname(installed), file)))
        );
        const effects: string[][] = [];
        schedules.runCommand = async (executable, args) => {
          effects.push([executable, ...args]);
        };
        for (const operation of ['status', 'remove', 'install'] as const) {
          const { exitCode, result } = await invokeResult(command, operation, schedules);
          expect(exitCode).toBe(1);
          expect(result).toMatchObject({ ok: false, error: expect.stringContaining(definition) });
          expect((await readdir(dirname(installed))).sort()).toEqual(files);
          expect(
            await Promise.all(files.map(file => readFile(join(dirname(installed), file))))
          ).toEqual(contents);
        }
        expect(effects).toEqual([]);
      }
    }
  );

  describe.each(['darwin', 'linux'] as const)('%s reinstall', platform => {
    testOnPosixHost.each(['ELOOP', 'EACCES'] as const)(
      'equivalent-home reinstall ignores unused %s log metadata while status still reads it',
      async errorCode => {
        const { root, archonHome, alias, schedules } = await fixture(idPrefix);
        schedules.platform = platform;
        schedules.systemdUserDirectory = join(root, 'units');
        const recordedHome = `${archonHome}${sep}`;
        process.env.ARCHON_HOME = recordedHome;
        const installed = await invoke(command, 'install', schedules);
        const definition = String(installed.path);
        const files = (await readdir(dirname(definition))).sort();
        const contents = await Promise.all(
          files.map(file => readFile(join(dirname(definition), file)))
        );
        const log = join(
          archonHome,
          'schedules',
          `${scheduleLabel(idForHome(idPrefix, recordedHome))}.log`
        );
        const metadataDirectory = join(root, 'log-metadata');
        if (errorCode === 'ELOOP') await symlink(log, log);
        else {
          await mkdir(metadataDirectory);
          const entry = join(metadataDirectory, 'entry');
          await writeFile(entry, 'log');
          await symlink(entry, log);
          await chmod(metadataDirectory, 0);
        }
        const loaded: string[][] = [];
        schedules.runCommand = async (executable, args) => {
          if (args[0] === 'print' || args[1] === 'is-active') throw new Error('Job is not loaded');
          loaded.push([executable, ...args]);
        };
        try {
          await expect(stat(log)).rejects.toMatchObject({ code: errorCode });
          for (const spelling of [recordedHome, archonHome, alias]) {
            process.env.ARCHON_HOME = spelling;
            expect(await invoke(command, 'install', schedules)).toMatchObject({
              path: installed.path,
            });
            const status = await invokeResult(command, 'status', schedules);
            expect(status.exitCode).toBe(1);
            expect(status.result).toMatchObject({
              ok: false,
              error: expect.stringContaining(errorCode),
            });
          }
          expect(
            loaded.filter(args => args.includes(platform === 'darwin' ? 'bootstrap' : 'enable'))
          ).toHaveLength(3);
          expect((await readdir(dirname(definition))).sort()).toEqual(files);
          expect(
            await Promise.all(files.map(file => readFile(join(dirname(definition), file))))
          ).toEqual(contents);
          expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
        } finally {
          if (errorCode === 'EACCES') await chmod(metadataDirectory, 0o700);
        }
      }
    );
  });

  testOnPosixHost.each(['darwin', 'linux'] as const)(
    '%s operations ignore a permission-denied trigger definition',
    async platform => {
      const { root, archonHome, alias, schedules } = await fixture(idPrefix);
      schedules.platform = platform;
      schedules.systemdUserDirectory = join(root, 'units');
      process.env.ARCHON_HOME = archonHome;
      const installed = await invoke(command, 'install', schedules);
      const otherHome = join(root, 'other-install');
      const other = await installNativeSchedule(
        {
          ...workflowWakeScheduleConfig(),
          id: createHash('sha256').update(otherHome).digest('hex'),
          archonHome: otherHome,
          workingDirectory: otherHome,
          programArguments: [
            process.execPath,
            'trigger',
            'fire',
            '--config',
            join(root, 'timer.json'),
          ],
        },
        schedules
      );
      const definition =
        platform === 'linux' ? other.path.replace(/\.timer$/, '.service') : other.path;
      const contents = await readFile(definition);
      await chmod(definition, 0);
      try {
        await expect(readFile(definition)).rejects.toMatchObject({ code: 'EACCES' });
        for (const spelling of [archonHome, alias]) {
          process.env.ARCHON_HOME = spelling;
          expect(await invoke(command, 'status', schedules)).toMatchObject({
            installed: true,
            path: installed.path,
          });
          expect(await invoke(command, 'install', schedules)).toMatchObject({
            path: installed.path,
          });
        }
        process.env.ARCHON_HOME = archonHome;
        expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
        await invoke(command, 'install', schedules);
        process.env.ARCHON_HOME = alias;
        expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
        expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: false });
      } finally {
        await chmod(definition, 0o600);
      }
      expect(await readFile(definition)).toEqual(contents);
    }
  );

  testOnPosixHost(
    'permission failure on the current target still fails every operation',
    async () => {
      const { archonHome, schedules } = await fixture(idPrefix);
      process.env.ARCHON_HOME = archonHome;
      const installed = await invoke(command, 'install', schedules);
      const definition = String(installed.path);
      await chmod(definition, 0);
      try {
        await expect(readFile(definition)).rejects.toMatchObject({ code: 'EACCES' });
        for (const operation of ['install', 'status', 'remove'] as const) {
          const { exitCode, result } = await invokeResult(command, operation, schedules);
          expect(exitCode).toBe(1);
          expect(result).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
        }
      } finally {
        await chmod(definition, 0o600);
      }
    }
  );

  testOnPosixHost('status and reinstall prefer the registered duplicate', async () => {
    const { archonHome, alias, schedules, jobFiles } = await fixture(idPrefix);
    const targets = [archonHome, `${archonHome}${sep}`].map(home => ({
      id: idForHome(idPrefix, home),
      archonHome: home,
    }));
    targets.sort((a, b) => a.id.localeCompare(b.id));
    const files = [];
    for (const target of targets) {
      const config =
        idPrefix === 'workflow-wake-'
          ? workflowWakeScheduleConfig(undefined, target)
          : isolationCleanupScheduleConfig(undefined, process.env, target);
      files.push((await installNativeSchedule(config, schedules)).path);
    }
    const active = targets[1];
    if (!active) throw new Error('Expected a second target');
    const registered = scheduleLabel(active.id);
    const loaded: string[] = [];
    schedules.runCommand = async (_executable, args) => {
      if (args[0] === 'print' && args[1] !== `gui/501/${registered}`)
        throw new Error('Job is not loaded');
      if (args[0] === 'bootstrap') loaded.push(args[2] ?? '');
    };
    process.env.ARCHON_HOME = alias;
    const passPaths = targets.map(target =>
      join(archonHome, 'schedules', `${target.id}.last-pass.json`)
    );
    const lastPass = { at: '2026-11-27T00:00:00.000Z', pid: 2, ok: false, parts: {} };
    const wake = idPrefix === 'workflow-wake-';
    if (wake) {
      for (const [index, path] of passPaths.entries())
        await writeFile(
          path,
          JSON.stringify(index === 1 ? lastPass : { ...lastPass, pid: 1, ok: true })
        );
    }

    expect(await invoke(command, 'status', schedules)).toMatchObject({
      installed: true,
      registered: true,
      path: files[1],
      ...(wake ? { lastPass } : {}),
    });
    expect(await invoke(command, 'install', schedules)).toMatchObject({ path: files[1] });
    expect(loaded).toEqual([]);
    expect(await jobFiles()).toHaveLength(2);
    expect(await invoke(command, 'remove', schedules)).toMatchObject({ removed: true });
    expect(await jobFiles()).toEqual([]);
    if (wake)
      for (const path of passPaths)
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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
    const { archonHome, alias, schedules, jobFiles } = await fixture(idPrefix);
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
    for (const spelling of [recordedHome, archonHome, alias]) {
      process.env.ARCHON_HOME = spelling;
      expect(await invoke(command, 'status', schedules)).toMatchObject({
        installed: true,
        path,
        ...(wake ? { lastPass } : {}),
      });
    }
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
