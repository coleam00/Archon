// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { triggerCheckFixtures } from '../test-support/trigger-check-fixture';
import {
  installNativeSchedule,
  inspectNativeSchedule,
  scheduleLabel,
  type NativeScheduleOptions,
} from '../triggers/native-schedule';
import { workflowWakeScheduleConfig, workflowWakeScheduleTarget } from './wake-schedule';

const { fixture, scheduleFixture } = triggerCheckFixtures();

test.skipIf(process.platform === 'win32')(
  'a source-free check does not require watcher log metadata across home spellings',
  async () => {
    const { root, archonHome, schedules, check } = await fixture();
    delete process.env.ARCHON_WEBHOOK_SOURCES;
    const recordedHome = `${archonHome}${sep}`;
    process.env.ARCHON_HOME = recordedHome;
    const target = workflowWakeScheduleTarget();
    await installNativeSchedule(workflowWakeScheduleConfig(), schedules);
    const alias = join(root, 'home-link');
    await symlink(archonHome, alias);
    const plugin = join(root, 'receive-only.mjs');
    await writeFile(
      plugin,
      "export default () => ({ receive: async () => ({ kind: 'ignored' }) });"
    );
    const configPath = join(root, 'sources.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        sources: [{ sourceInstanceId: 'receive-only', module: plugin, config: {} }],
      })
    );
    const stateDirectory = join(archonHome, 'schedules');
    const log = join(stateDirectory, `${scheduleLabel(target.id)}.log`);
    await chmod(stateDirectory, 0);
    try {
      await expect(stat(log)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(inspectNativeSchedule(target, schedules)).rejects.toMatchObject({
        code: 'EACCES',
      });
      for (const sources of [undefined, configPath]) {
        if (sources) process.env.ARCHON_WEBHOOK_SOURCES = sources;
        else delete process.env.ARCHON_WEBHOOK_SOURCES;
        for (const spelling of [recordedHome, archonHome, alias]) {
          process.env.ARCHON_HOME = spelling;
          const result = await check();
          expect(result.error).toBeUndefined();
          expect(result.observing).toBeUndefined();
        }
      }
    } finally {
      await chmod(stateDirectory, 0o700);
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'reports a corrupted native definition and fails trigger checking',
  async () => {
    const { root, config, installTimer, check, scheduled } = await fixture();
    const path = join(root, 'timer.json');
    await writeFile(path, JSON.stringify(config({ a: 1 })));
    const definition = await installTimer(path);
    await writeFile(definition, '<plist/>');
    scheduled.length = 0;

    const result = await check();

    expect(result.bindings).toEqual([
      expect.objectContaining({
        file: definition,
        timer: definition,
        workflowName: null,
        problems: [expect.any(String)],
      }),
    ]);
    expect(result.error).toBeInstanceOf(Error);
    expect(scheduled).toEqual([]);
  }
);

async function seedUnresolvableCleanupHome(root: string, schedules: NativeScheduleOptions) {
  const archonHome = join(root, 'other-install');
  await installNativeSchedule(
    {
      id: `isolation-cleanup-${createHash('sha256').update(archonHome).digest('hex')}`,
      archonHome,
      workingDirectory: archonHome,
      programArguments: [process.execPath, 'isolation', 'cleanup', '--merged'],
      path: '/usr/bin',
      schedule: { intervalSeconds: 60, runAtLoad: true },
      output: 'log',
      removeCommand: 'archon isolation cleanup schedule remove',
    },
    schedules
  );
  await rm(archonHome, { recursive: true });
  await symlink(archonHome, archonHome);
}

test.skipIf(process.platform === 'win32')(
  'check ignores another job family with an unresolvable home',
  async () => {
    const { root, config, installTimer, check, schedules, scheduled } = await fixture();
    const path = join(root, 'timer.json');
    await writeFile(path, JSON.stringify(config({ a: 1 })));
    await installTimer(path);
    await seedUnresolvableCleanupHome(root, schedules);
    scheduled.length = 0;

    const result = await check();
    expect(result.bindings).toEqual([expect.objectContaining({ file: path, problems: [] })]);
    expect(result.error).toBeUndefined();
    expect(scheduled).toEqual([]);
  }
);

describe('schedule finds the binding timer however ARCHON_HOME is spelled', () => {
  test.skipIf(process.platform === 'win32')(
    'another job family with an unresolvable home does not block schedule operations',
    async () => {
      const { root, schedules, schedule, timerFiles } = await scheduleFixture();
      await schedule('install');
      const installed = await timerFiles();
      await seedUnresolvableCleanupHome(root, schedules);

      expect(await schedule('status')).toMatchObject({ installed: true, registered: true });
      await schedule('install');
      expect(await timerFiles()).toHaveLength(installed.length + 1);
      expect(await schedule('remove')).toMatchObject({ removed: true });
      const remaining = await timerFiles();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toContain('isolation-cleanup-');
      expect(await schedule('remove')).toMatchObject({ removed: false });
    }
  );

  test.skipIf(process.platform === 'win32')(
    'a potentially matching recorded home failure is not successful absence',
    async () => {
      const { archonHome, alias, schedule } = await scheduleFixture();
      process.env.ARCHON_HOME = alias;
      await schedule('install');
      await rm(alias);
      await symlink(alias, alias);
      process.env.ARCHON_HOME = archonHome;

      for (const operation of ['install', 'status', 'remove']) {
        await expect(schedule(operation)).rejects.toMatchObject({ code: 'ELOOP' });
      }
    }
  );

  test.skipIf(process.platform === 'win32')(
    'remove reaches an unreadable current timer beside a readable alternate',
    async () => {
      const { archonHome, schedules, schedule, timerFiles } = await scheduleFixture();
      process.env.ARCHON_HOME = `${archonHome}${sep}`;
      await schedule('install');
      const currentId = createHash('sha256')
        .update(JSON.stringify([archonHome, 'timer', 'timer']))
        .digest('hex');
      await writeFile(
        join(schedules.launchAgentsDirectory!, `${scheduleLabel(currentId)}.plist`),
        '<plist/>'
      );
      expect(await timerFiles()).toHaveLength(2);

      process.env.ARCHON_HOME = archonHome;
      expect(await schedule('remove')).toMatchObject({ removed: true });
      expect(await timerFiles()).toEqual([]);
    }
  );
});
