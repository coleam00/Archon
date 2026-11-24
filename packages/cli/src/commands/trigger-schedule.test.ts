// @archon-test-isolated
// @archon-test-windows
/**
 * `archon trigger schedule` finds a binding's timer by the install it belongs to, however
 * ARCHON_HOME is spelled, and a remove that finds nothing fails.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { loadConfig } from '@archon/core/config/config-loader';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import {
  createInMemoryWorkflowHostStore,
  createInMemoryWorkflowStore,
} from '../test-support/workflow-store';
import { installNativeSchedule, type NativeScheduleOptions } from '../triggers/native-schedule';
import { triggerCommand } from './trigger';

const tempRoots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

async function fixture() {
  const root = tempRoots(await realpath(await mkdtemp(join(tmpdir(), 'archon-trigger-schedule-'))));
  const home = join(root, 'home');
  const linked = join(root, 'linked-home');
  const otherHome = join(root, 'other-home');
  await mkdir(home);
  await mkdir(otherHome);
  await symlink(home, linked);
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const deps = {
    store,
    providers: providerRegistry,
    loadConfig,
    getAgentProvider: (): never => {
      throw new Error('No AI provider');
    },
  };
  // Only `install` reads the host, for the run-as user; nothing here runs a workflow.
  const host = {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
  } as unknown as WorkflowHost;
  const user = await records.users.findOrCreateUserByPlatformIdentity('cli', 'me', 'me');
  if (!user) throw new Error('The in-memory store did not create a user');
  const configPath = join(root, 'timer.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      sourceInstanceId: 'timer',
      binding: {
        bindingId: 'timer',
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: user.id,
        resource: 'stage',
        overlap: 'queue',
        launch: { cwd: root, workflowName: 'stage', inputs: {}, isolation: { kind: 'in-place' } },
      },
      schedule: { intervalSeconds: 1800, runAtLoad: false },
    })
  );
  const runCommand: NativeScheduleOptions['runCommand'] = async () => undefined;
  // A job is validated by its scheduler's path rules, so the scheduler must accept this
  // host's paths: Task Scheduler on Windows, launchd elsewhere. Task Scheduler keeps a job's
  // files under the home it was installed for; launchd keeps every home's in one directory.
  const { schedules, jobDirectory, suffix } =
    process.platform === 'win32'
      ? {
          schedules: { platform: 'win32', windowsUserId: 'me', runCommand } as const,
          jobDirectory: join(home, 'schedules'),
          suffix: '.xml',
        }
      : {
          schedules: {
            platform: 'darwin',
            uid: 501,
            launchAgentsDirectory: join(root, 'LaunchAgents'),
            runCommand,
          } as const,
          jobDirectory: join(root, 'LaunchAgents'),
          suffix: '.plist',
        };
  /** Runs one `schedule` operation with ARCHON_HOME spelled `archonHome`; resolves to what it printed. */
  const run = async (operation: string, archonHome: string): Promise<string> => {
    process.env.ARCHON_HOME = archonHome;
    let printed = '';
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      encodingOrCallback?: unknown,
      callback?: () => void
    ) => {
      printed += String(chunk);
      (typeof encodingOrCallback === 'function'
        ? (encodingOrCallback as () => void)
        : callback)?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      await triggerCommand(host, 'schedule', [operation], { config: configPath }, { schedules });
    } finally {
      stdout.mockRestore();
    }
    return printed;
  };
  const schedule = async (operation: string, archonHome: string) =>
    JSON.parse(await run(operation, archonHome)) as Record<string, unknown>;
  const jobFiles = async (): Promise<string[]> =>
    (await readdir(jobDirectory).catch(() => [])).filter(
      name => name.startsWith('com.archon.trigger.') && name.endsWith(suffix)
    );
  /** A job as Archon named it before the id was taken from the home's identity. */
  const installLegacy = async (archonHome: string): Promise<void> => {
    await installNativeSchedule(
      {
        id: createHash('sha256')
          .update(JSON.stringify([archonHome, 'timer', 'timer']))
          .digest('hex'),
        programArguments: [process.execPath, 'trigger', 'fire', '--config', configPath],
        workingDirectory: root,
        archonHome,
        path: process.env.PATH ?? '',
        schedule: { intervalSeconds: 1800, runAtLoad: false },
        output: 'log',
        removeCommand: `archon trigger schedule remove --config ${configPath}`,
      },
      schedules
    );
  };
  return { home, linked, otherHome, run, schedule, jobFiles, installLegacy };
}

test('status and remove find a timer installed under another spelling of the same home', async () => {
  const { home, linked, schedule, jobFiles } = await fixture();
  await schedule('install', `${home}${sep}`);
  expect(await jobFiles()).toHaveLength(1);

  expect(await schedule('status', home)).toMatchObject({ installed: true });
  expect(await schedule('status', linked)).toMatchObject({ installed: true });

  const removed = await schedule('remove', linked);
  expect(removed.removed).toEqual([expect.stringContaining('com.archon.trigger.')]);
  expect(await jobFiles()).toEqual([]);
});

test('every spelling of a home installs the one job', async () => {
  const { home, linked, schedule, jobFiles } = await fixture();
  await schedule('install', `${home}${sep}`);
  const [installed] = await jobFiles();

  await schedule('install', home).catch(() => undefined);
  await schedule('install', linked).catch(() => undefined);
  expect(await jobFiles()).toEqual([installed]);

  await schedule('remove', home);
  await schedule('install', linked);
  expect(await jobFiles()).toEqual([installed]);
});

test('a timer installed before the id followed the home identity is found and not duplicated', async () => {
  const { home, linked, schedule, jobFiles, installLegacy } = await fixture();
  for (const spelling of [home, linked]) {
    await installLegacy(`${home}${sep}`);
    expect(await schedule('status', spelling)).toMatchObject({ installed: true });
    await expect(schedule('install', spelling)).rejects.toThrow();
    expect(await jobFiles()).toHaveLength(1);
    await schedule('remove', spelling);
    expect(await jobFiles()).toEqual([]);
  }
});

test('another home sharing the scheduler does not see or remove this home’s timer', async () => {
  const { home, otherHome, schedule, run, jobFiles } = await fixture();
  await schedule('install', home);
  const installed = await jobFiles();

  expect(await schedule('status', otherHome)).toMatchObject({ installed: false });
  await expect(run('remove', otherHome)).rejects.toThrow();
  expect(await jobFiles()).toEqual(installed);
});

test('remove with no timer installed fails rather than reporting a removal', async () => {
  const { home, run } = await fixture();
  await expect(run('remove', home)).rejects.toThrow();
});
