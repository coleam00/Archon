import { afterEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  inspectNativeSchedule,
  installNativeSchedule,
  listNativeSchedules,
  NativeScheduleUnsupportedError,
  removeNativeSchedule,
  scheduledJob,
  type NativeScheduleConfig,
  type NativeScheduleOptions,
} from './native-schedule';
import { renderMacosLaunchAgent } from './native-schedule-launchd';
import { renderSystemdUnits } from './native-schedule-systemd';
import { renderTaskDefinition, renderTaskWrapper } from './native-schedule-task-scheduler';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const LABEL = 'com.archon.trigger.source-refresh';
/** A launchd or systemd job needs POSIX paths, and a Windows host's scratch directories are not. */
const itOnPosixHost = it.skipIf(process.platform === 'win32');

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

function config(overrides: Partial<NativeScheduleConfig> = {}): NativeScheduleConfig {
  return {
    id: 'source-refresh',
    programArguments: ['/opt/archon/bin/archon', 'trigger', 'fire', '--config', '/tmp/a&b.json'],
    workingDirectory: '/Users/example/Project <one>',
    archonHome: '/Users/example/.archon',
    path: '/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin',
    schedule: { intervalSeconds: 37, runAtLoad: false },
    output: 'log',
    removeCommand: 'archon trigger schedule remove --config /tmp/a&b.json',
    ...overrides,
  };
}

async function scratchDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'archon-native-schedule-'));
  tempRoots.push(path);
  return path;
}

type SchedulerCommand = string[];

/** Records every scheduler command; `fails` decides which of them exit non-zero. */
function recorder(fails: (command: SchedulerCommand) => boolean = () => false): {
  commands: SchedulerCommand[];
  runCommand: NonNullable<NativeScheduleOptions['runCommand']>;
} {
  const commands: SchedulerCommand[] = [];
  return {
    commands,
    runCommand: async (executable, args) => {
      const command = [executable, ...args];
      commands.push(command);
      if (fails(command)) throw new Error(`${command.join(' ')} failed`);
    },
  };
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false
  );
}

describe('scheduledJob', () => {
  it('rejects settings no scheduler can represent as the owned job', () => {
    expect(() => scheduledJob(config({ id: '../other-job' }))).toThrow('Native schedule id must');
    expect(() =>
      scheduledJob(config({ programArguments: ['archon', 'trigger', 'fire'] }), 'darwin')
    ).toThrow('executable must be an absolute path');
    expect(() =>
      scheduledJob(config({ schedule: { intervalSeconds: 0, runAtLoad: false } }))
    ).toThrow('positive integer');
    expect(() => scheduledJob(config({ path: '' }))).toThrow('PATH must not be empty');
  });

  it("checks absolute paths by the target platform's rules", () => {
    const windows = config({
      programArguments: ['C:\\archon\\archon.exe', 'trigger', 'fire'],
      workingDirectory: 'C:\\work',
      archonHome: 'C:\\Users\\me\\.archon',
    });
    expect(scheduledJob(windows, 'win32').label).toBe(LABEL);
    expect(() => scheduledJob(windows, 'linux')).toThrow('must be an absolute path');
  });
});

describe('launchd', () => {
  const darwin = (directory: string, runCommand: NativeScheduleOptions['runCommand']) => ({
    platform: 'darwin' as const,
    uid: 501,
    launchAgentsDirectory: directory,
    runCommand,
  });

  it('renders escaped arguments as an argv array and logs output only when asked', () => {
    const plist = renderMacosLaunchAgent(scheduledJob(config(), 'darwin'));
    expect(plist).toContain('<string>/tmp/a&amp;b.json</string>');
    expect(plist).toContain('<string>/Users/example/Project &lt;one&gt;</string>');
    expect(plist).toContain('<integer>37</integer>');
    expect(plist).toContain('<false/>');
    expect(plist).not.toContain('<key>Program</key>');
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain(`<string>/Users/example/.archon/schedules/${LABEL}.log</string>`);

    const discarded = renderMacosLaunchAgent(scheduledJob(config({ output: 'discard' }), 'darwin'));
    expect(discarded).not.toContain('StandardOutPath');
    expect(discarded).not.toContain('StandardErrorPath');
  });

  it.skipIf(process.platform !== 'darwin')(
    'gives the job exactly ARCHON_HOME and the installing PATH, and the log, as macOS reads them',
    async () => {
      const directory = await scratchDirectory();
      const path = join(directory, 'job.plist');
      const pathWithMarkup = '/Users/example/tools & <bin>:/usr/bin';
      await writeFile(
        path,
        renderMacosLaunchAgent(scheduledJob(config({ path: pathWithMarkup }), 'darwin'))
      );
      const extract = async (key: string): Promise<unknown> =>
        JSON.parse(
          (await execFileAsync('/usr/bin/plutil', ['-extract', key, 'json', '-o', '-', path]))
            .stdout
        );
      expect(await extract('EnvironmentVariables')).toEqual({
        ARCHON_HOME: '/Users/example/.archon',
        PATH: pathWithMarkup,
      });
      for (const key of ['StandardOutPath', 'StandardErrorPath']) {
        const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', path]);
        expect(stdout.trim()).toBe(`/Users/example/.archon/schedules/${LABEL}.log`);
      }
    }
  );

  itOnPosixHost('installs and removes only the exact owned launch agent', async () => {
    const directory = await scratchDirectory();
    const archonHome = await scratchDirectory();
    const { commands, runCommand } = recorder();
    const job = config({ archonHome });

    const installed = await installNativeSchedule(job, darwin(directory, runCommand));
    const path = join(directory, `${LABEL}.plist`);
    expect(installed).toEqual({ path, log: join(archonHome, 'schedules', `${LABEL}.log`) });
    expect(await readFile(path, 'utf8')).toBe(renderMacosLaunchAgent(scheduledJob(job)));
    expect(commands).toEqual([['/bin/launchctl', 'bootstrap', 'gui/501', path]]);

    expect(await removeNativeSchedule(job, darwin(directory, runCommand))).toBe(true);
    expect(commands.slice(1)).toEqual([
      ['/bin/launchctl', 'print', `gui/501/${LABEL}`],
      ['/bin/launchctl', 'bootout', 'gui/501', path],
    ]);
    expect(await exists(path)).toBe(false);
  });

  itOnPosixHost(
    'refuses to replace a different configuration under the same owned id',
    async () => {
      const directory = await scratchDirectory();
      const path = join(directory, `${LABEL}.plist`);
      await writeFile(path, 'user-owned or stale contents');
      const { commands, runCommand } = recorder();

      await expect(
        installNativeSchedule(
          config({ archonHome: await scratchDirectory() }),
          darwin(directory, runCommand)
        )
      ).rejects.toThrow(/Refusing to replace.*archon trigger schedule remove/);
      expect(commands).toEqual([]);
      expect(await readFile(path, 'utf8')).toBe('user-owned or stale contents');
    }
  );

  itOnPosixHost('rolls back a newly written plist when launchd rejects installation', async () => {
    const directory = await scratchDirectory();
    const { runCommand } = recorder(() => true);
    await expect(
      installNativeSchedule(
        config({ archonHome: await scratchDirectory() }),
        darwin(directory, runCommand)
      )
    ).rejects.toThrow('bootstrap');
    expect(await readdir(directory)).toEqual([]);
  });

  itOnPosixHost(
    'loads an identical plist launchd has not loaded, and leaves a loaded one alone',
    async () => {
      const directory = await scratchDirectory();
      const job = config({ archonHome: await scratchDirectory() });
      const path = join(directory, `${LABEL}.plist`);
      await writeFile(path, renderMacosLaunchAgent(scheduledJob(job)));

      const unloaded = recorder(command => command[1] === 'print');
      await installNativeSchedule(job, darwin(directory, unloaded.runCommand));
      expect(unloaded.commands).toEqual([
        ['/bin/launchctl', 'print', `gui/501/${LABEL}`],
        ['/bin/launchctl', 'bootstrap', 'gui/501', path],
      ]);

      const loaded = recorder();
      await installNativeSchedule(job, darwin(directory, loaded.runCommand));
      expect(loaded.commands).toEqual([['/bin/launchctl', 'print', `gui/501/${LABEL}`]]);
    }
  );

  itOnPosixHost(
    'removes a plist launchd has not loaded, and keeps one launchd refuses to unload',
    async () => {
      const directory = await scratchDirectory();
      const path = join(directory, `${LABEL}.plist`);
      await writeFile(path, 'installed');

      const refused = recorder(command => command[1] === 'bootout');
      await expect(
        removeNativeSchedule(config(), darwin(directory, refused.runCommand))
      ).rejects.toThrow('bootout');
      expect(await exists(path)).toBe(true);

      const unloaded = recorder(command => command[1] === 'print');
      expect(await removeNativeSchedule(config(), darwin(directory, unloaded.runCommand))).toBe(
        true
      );
      expect(unloaded.commands.map(command => command[1])).toEqual(['print']);
      expect(await exists(path)).toBe(false);
    }
  );
});

describe('systemd user timer', () => {
  it('renders the environment, argv, output and timing as systemd reads them', () => {
    const units = renderSystemdUnits(
      scheduledJob(
        config({
          programArguments: ['/opt/archon/bin/archon', 'fire', 'a "quoted" $HOME 100% \\x'],
          workingDirectory: '/srv/50% work',
          path: '/home/me/bin:/usr/bin',
          schedule: { intervalSeconds: 300, runAtLoad: true },
        }),
        'linux'
      )
    );
    expect(units.service).toContain('Type=oneshot');
    expect(units.service).toContain('KillMode=process');
    expect(units.service).toContain('WorkingDirectory=/srv/50%% work');
    expect(units.service).toContain('Environment="ARCHON_HOME=/Users/example/.archon"');
    expect(units.service).toContain('Environment="PATH=/home/me/bin:/usr/bin"');
    expect(units.service).toContain(
      'ExecStart="/opt/archon/bin/archon" "fire" "a \\"quoted\\" $$HOME 100%% \\\\x"'
    );
    expect(units.service).toContain(
      `StandardOutput=append:/Users/example/.archon/schedules/${LABEL}.log`
    );
    expect(units.timer).toContain('OnActiveSec=1s');
    expect(units.timer).toContain('OnUnitActiveSec=300s');
    expect(units.timer).toContain('AccuracySec=1s');

    const later = renderSystemdUnits(scheduledJob(config({ output: 'discard' }), 'linux'));
    expect(later.timer).toContain('OnActiveSec=37s');
    expect(later.service).toContain('StandardOutput=null');
    expect(() =>
      renderSystemdUnits(scheduledJob(config({ programArguments: ['/bin/a', 'x\ny'] }), 'linux'))
    ).toThrow('line break');
  });

  it.skipIf(process.platform !== 'linux' || !Bun.which('systemd-analyze'))(
    'writes units systemd-analyze accepts',
    async () => {
      const directory = await scratchDirectory();
      const units = renderSystemdUnits(
        scheduledJob(
          config({
            programArguments: [process.execPath, '--version'],
            workingDirectory: directory,
            archonHome: directory,
          }),
          'linux'
        )
      );
      await writeFile(join(directory, `${LABEL}.service`), units.service);
      await writeFile(join(directory, `${LABEL}.timer`), units.timer);
      await execFileAsync('systemd-analyze', [
        'verify',
        '--user',
        join(directory, `${LABEL}.service`),
        join(directory, `${LABEL}.timer`),
      ]);
    }
  );

  itOnPosixHost('installs, reports and removes exactly the two owned units', async () => {
    const units = await scratchDirectory();
    const archonHome = await scratchDirectory();
    const job = config({ archonHome });
    const inactive = { value: false };
    const { commands, runCommand } = recorder(
      command => command[2] === 'is-active' && inactive.value
    );
    const linux = { platform: 'linux' as const, systemdUserDirectory: units, runCommand };
    const timer = join(units, `${LABEL}.timer`);
    const service = join(units, `${LABEL}.service`);
    const log = join(archonHome, 'schedules', `${LABEL}.log`);

    expect(await installNativeSchedule(job, linux)).toEqual({ path: timer, log });
    expect(commands).toEqual([
      ['systemctl', '--user', 'show-environment'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', `${LABEL}.timer`],
    ]);
    const rendered = renderSystemdUnits(scheduledJob(job, 'linux'));
    expect(await readFile(timer, 'utf8')).toBe(rendered.timer);
    expect(await readFile(service, 'utf8')).toBe(rendered.service);

    commands.length = 0;
    await installNativeSchedule(job, linux);
    expect(commands.map(command => command[2])).toEqual(['show-environment', 'is-active']);

    expect(await inspectNativeSchedule(job, linux)).toEqual({
      path: timer,
      registered: true,
      log,
      lastRunAt: null,
    });
    await writeFile(log, 'ran\n');
    const ranAt = new Date('2026-11-18T08:00:00.000Z');
    await utimes(log, ranAt, ranAt);
    inactive.value = true;
    expect(await inspectNativeSchedule(job, linux)).toMatchObject({
      registered: false,
      lastRunAt: ranAt.toISOString(),
    });

    commands.length = 0;
    expect(await removeNativeSchedule(job, linux)).toBe(true);
    expect(commands).toEqual([
      ['systemctl', '--user', 'disable', '--now', `${LABEL}.timer`],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(await readdir(units)).toEqual([]);
    expect(await readFile(log, 'utf8')).toBe('ran\n');
    expect(await removeNativeSchedule(job, linux)).toBe(false);
    expect(await inspectNativeSchedule(job, linux)).toBeUndefined();
  });

  itOnPosixHost(
    'answers with the command to schedule by hand when no user manager is reachable',
    async () => {
      const units = await scratchDirectory();
      const { commands, runCommand } = recorder(() => true);
      const job = config({ programArguments: ['/opt/archon', "it's"], archonHome: units });
      const failure = await installNativeSchedule(job, {
        platform: 'linux',
        systemdUserDirectory: units,
        runCommand,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(NativeScheduleUnsupportedError);
      expect((failure as Error).message).toContain('systemctl --user is not reachable');
      expect((failure as Error).message).toContain(
        `cd '/Users/example/Project <one>' && ARCHON_HOME='${units}' PATH='/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin' '/opt/archon' 'it'\\''s'`
      );
      expect(commands).toHaveLength(1);
      expect(await readdir(units)).toEqual([]);
    }
  );
});

describe('Task Scheduler', () => {
  const launcher = ['C:\\Program Files\\archon\\archon.exe'] as const;
  const windowsJob = (overrides: Partial<NativeScheduleConfig> = {}) =>
    config({
      programArguments: [
        'C:\\Program Files\\archon\\archon.exe',
        'trigger',
        'fire',
        '--config',
        'C:\\packs\\a&b 100%.json',
        'C:\\trailing\\',
      ],
      workingDirectory: 'C:\\Users\\me\\Project (one)',
      path: 'C:\\Users\\me\\.bun\\bin;C:\\Windows\\System32',
      schedule: { intervalSeconds: 300, runAtLoad: true },
      ...overrides,
    });

  it('renders a wrapper that sets exactly ARCHON_HOME and PATH and appends to the log', () => {
    const wrapper = renderTaskWrapper(
      scheduledJob(windowsJob({ archonHome: 'C:\\home' }), 'win32')
    );
    const lines = wrapper.split('\r\n');
    expect(lines.filter(line => line.startsWith('set '))).toEqual([
      'set "ARCHON_HOME=C:\\home"',
      'set "PATH=C:\\Users\\me\\.bun\\bin;C:\\Windows\\System32"',
    ]);
    expect(wrapper).toContain(
      '(cd /d "C:\\Users\\me\\Project (one)" && "C:\\Program Files\\archon\\archon.exe" "trigger" "fire" "--config" "C:\\packs\\a&b 100%%.json" "C:\\trailing\\\\")'
    );
    expect(wrapper).toContain(`>> "C:\\home\\schedules\\${LABEL}.log" 2>&1`);
    expect(() =>
      renderTaskWrapper(scheduledJob(windowsJob({ path: 'C:\\"bin' }), 'win32'))
    ).toThrow('double quote');
  });

  it('renders a task that repeats in whole minutes, never overlaps and runs on battery', () => {
    const job = scheduledJob(windowsJob({ archonHome: 'C:\\home' }), 'win32');
    const xml = renderTaskDefinition(job, 'DOMAIN\\me', launcher);
    expect(xml).toContain('<Interval>PT5M</Interval>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<LogonTrigger><UserId>DOMAIN\\me</UserId>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    // The wrapper runs through the launcher, whose own console has no window.
    expect(xml).toContain('<Command>%SystemRoot%\\System32\\conhost.exe</Command>');
    expect(xml).toContain(
      `<Arguments>--headless &quot;C:\\Program Files\\archon\\archon.exe&quot; &quot;--internal-schedule-launch&quot; &quot;C:\\home${join('/schedules', `${LABEL}.cmd`)}&quot;</Arguments>`
    );
    expect(
      renderTaskDefinition(
        scheduledJob(windowsJob({ schedule: { intervalSeconds: 60, runAtLoad: false } }), 'win32'),
        'me',
        launcher
      )
    ).not.toContain('LogonTrigger');

    for (const intervalSeconds of [37, 90, 32 * 86400]) {
      expect(() =>
        renderTaskDefinition(
          scheduledJob(windowsJob({ schedule: { intervalSeconds, runAtLoad: false } }), 'win32'),
          'me',
          launcher
        )
      ).toThrow(`${String(intervalSeconds)} seconds`);
    }
    expect(() =>
      renderTaskDefinition(
        scheduledJob(windowsJob({ archonHome: 'C:\\%TEMP%' }), 'win32'),
        'me',
        launcher
      )
    ).toThrow('%');
    // Task Scheduler expands %NAME% in the launcher's path too, and cmd cannot quote a `"`.
    const otherJob = scheduledJob(windowsJob(), 'win32');
    expect(() => renderTaskDefinition(otherJob, 'me', ['C:\\%USERNAME%\\archon.exe'])).toThrow('%');
    expect(() => renderTaskDefinition(otherJob, 'me', ['C:\\a"b\\archon.exe'])).toThrow(
      'double quote'
    );
  });

  it('installs, reports and removes the task and its two files, keeping the log', async () => {
    const archonHome = await scratchDirectory();
    const job = windowsJob({ archonHome });
    const { commands, runCommand } = recorder();
    const win32 = {
      platform: 'win32' as const,
      windowsUserId: 'me',
      windowsLauncher: launcher,
      runCommand,
    };
    const schedules = join(archonHome, 'schedules');
    const xml = join(schedules, `${LABEL}.xml`);
    const task = `\\Archon\\${LABEL}`;

    expect((await installNativeSchedule(job, win32)).path).toBe(xml);
    expect(commands).toEqual([
      ['schtasks.exe', '/Create', '/TN', task, '/XML', xml, '/F'],
      ['schtasks.exe', '/Run', '/TN', task],
    ]);
    const definition = await readFile(xml);
    expect([...definition.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(definition.subarray(2).toString('utf16le')).toBe(
      renderTaskDefinition(scheduledJob(job, 'win32'), 'me', launcher)
    );
    expect(await readFile(join(schedules, `${LABEL}.cmd`), 'utf8')).toBe(
      renderTaskWrapper(scheduledJob(job, 'win32'))
    );
    expect(await inspectNativeSchedule(job, win32)).toMatchObject({ path: xml, registered: true });

    await writeFile(join(schedules, `${LABEL}.log`), 'ran\n');
    commands.length = 0;
    expect(await removeNativeSchedule(job, win32)).toBe(true);
    expect(commands).toEqual([
      ['schtasks.exe', '/Query', '/TN', task],
      ['schtasks.exe', '/Delete', '/TN', task, '/F'],
    ]);
    expect(await readdir(schedules)).toEqual([`${LABEL}.log`]);
  });

  it('removes the files of a task the scheduler no longer has', async () => {
    const archonHome = await scratchDirectory();
    const job = windowsJob({ archonHome });
    await installNativeSchedule(job, {
      platform: 'win32',
      windowsUserId: 'me',
      runCommand: recorder().runCommand,
    });
    // A task that is gone fails both /Query and /Delete.
    const { commands, runCommand } = recorder(command =>
      ['/Query', '/Delete'].includes(command[1])
    );

    expect(
      await removeNativeSchedule(job, { platform: 'win32', windowsUserId: 'me', runCommand })
    ).toBe(true);
    expect(commands.map(command => command[1])).toEqual(['/Query']);
    expect(await readdir(join(archonHome, 'schedules'))).toEqual([]);
  });

  it('deletes the task and its files when the first run cannot start', async () => {
    const archonHome = await scratchDirectory();
    const { commands, runCommand } = recorder(command => command[1] === '/Run');
    await expect(
      installNativeSchedule(windowsJob({ archonHome }), {
        platform: 'win32',
        windowsUserId: 'me',
        runCommand,
      })
    ).rejects.toThrow('/Run');
    expect(commands.map(command => command[1])).toEqual(['/Create', '/Run', '/Delete']);
    expect(await readdir(join(archonHome, 'schedules'))).toEqual([]);
  });

  it('refuses an interval Task Scheduler cannot repeat before touching the host', async () => {
    const archonHome = await scratchDirectory();
    const { commands, runCommand } = recorder();
    await expect(
      installNativeSchedule(
        windowsJob({ archonHome, schedule: { intervalSeconds: 90, runAtLoad: false } }),
        { platform: 'win32', windowsUserId: 'me', runCommand }
      )
    ).rejects.toThrow('whole number of minutes');
    expect(commands).toEqual([]);
    expect(await readdir(archonHome)).toEqual([]);
  });
});

// Check reads a job's command back from the file install rendered, so each reader must
// return exactly what its renderer was given, including the characters it escapes.
describe('reading installed jobs back', () => {
  const posixConfig = `/tmp/a&b <c> "q" 'x' 100% $HOME\\.json`;

  itOnPosixHost.each([
    [
      'launchd',
      (directory: string) => ({
        platform: 'darwin' as const,
        uid: 501,
        launchAgentsDirectory: directory,
      }),
    ],
    [
      'systemd',
      (directory: string) => ({ platform: 'linux' as const, systemdUserDirectory: directory }),
    ],
  ] as const)(
    '%s returns the argv and ARCHON_HOME it wrote, and only for that home',
    async (_, options) => {
      const root = await scratchDirectory();
      const archonHome = join(root, 'home 100% $x');
      const scheduler = { ...options(join(root, 'jobs')), runCommand: recorder().runCommand };
      const programArguments = [
        '/opt/archon/bin/archon',
        'trigger',
        'fire',
        '--config',
        posixConfig,
      ] as const;
      await installNativeSchedule(config({ archonHome, programArguments }), scheduler);
      await installNativeSchedule(
        config({ id: 'other-home', archonHome: join(root, 'other') }),
        scheduler
      );

      expect(await listNativeSchedules(archonHome, scheduler)).toEqual([
        expect.objectContaining({ label: LABEL, archonHome, programArguments }),
      ]);
      // ARCHON_HOME is taken as written; another spelling of the same home finds the job.
      expect(await listNativeSchedules(`${archonHome}/`, scheduler)).toEqual([
        expect.objectContaining({ label: LABEL }),
      ]);
    }
  );

  it('Task Scheduler returns the argv and ARCHON_HOME it wrote', async () => {
    const archonHome = await scratchDirectory();
    const programArguments = [
      'C:\\Program Files\\archon\\archon.exe',
      'trigger',
      'fire',
      '--config',
      'C:\\packs\\a&b <c> 100% $x.json',
      'C:\\trailing\\',
    ] as const;
    const win32 = {
      platform: 'win32' as const,
      windowsUserId: 'me',
      runCommand: recorder().runCommand,
    };
    await installNativeSchedule(
      config({
        archonHome,
        programArguments,
        workingDirectory: 'C:\\Users\\me\\Project (one)',
        path: 'C:\\Windows\\System32',
        schedule: { intervalSeconds: 300, runAtLoad: false },
      }),
      win32
    );

    expect(await listNativeSchedules(archonHome, win32)).toEqual([
      expect.objectContaining({
        label: LABEL,
        archonHome,
        programArguments: [...programArguments],
      }),
    ]);
  });

  itOnPosixHost('keeps a job file it cannot read, as unreadable', async () => {
    const directory = await scratchDirectory();
    await writeFile(join(directory, `${LABEL}.plist`), '<plist/>');
    expect(
      await listNativeSchedules('/home', {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
      })
    ).toEqual([expect.objectContaining({ label: LABEL, unreadable: expect.any(String) })]);
  });
});

describe('a host with no supported scheduler', () => {
  it('prints the command to schedule by hand on install, and a plain answer otherwise', async () => {
    const failure = await installNativeSchedule(config(), { platform: 'freebsd' }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(NativeScheduleUnsupportedError);
    expect((failure as Error).message).toContain('every 37 seconds');
    expect((failure as Error).message).toContain(
      "'/opt/archon/bin/archon' 'trigger' 'fire' '--config' '/tmp/a&b.json'"
    );
    await expect(inspectNativeSchedule(config(), { platform: 'freebsd' })).rejects.toBeInstanceOf(
      NativeScheduleUnsupportedError
    );
    await expect(removeNativeSchedule(config(), { platform: 'freebsd' })).rejects.toBeInstanceOf(
      NativeScheduleUnsupportedError
    );
  });
});

describe('workflow wake native schedule', () => {
  itOnPosixHost(
    'installs the generated wake argv, preserves configuration and removes only that job',
    async () => {
      const { workflowWakeScheduleConfig } = await import('../commands/wake-schedule');
      const generated = workflowWakeScheduleConfig(5);
      const originalId = generated.id;
      expect(workflowWakeScheduleConfig(10).id).toBe(originalId);
      // A second install on the machine gets its own job.
      const home = process.env.ARCHON_HOME;
      process.env.ARCHON_HOME = await scratchDirectory();
      try {
        expect(workflowWakeScheduleConfig(5).id).not.toBe(originalId);
      } finally {
        if (home === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = home;
      }
      expect(generated.programArguments.slice(-4)).toEqual([
        'workflow',
        'wake',
        '--watch',
        '--json',
      ]);
      expect(generated.programArguments[0]).toBe(process.execPath);
      expect(generated.programArguments[1]).toBe(resolve(process.argv[1]));
      expect(generated.workingDirectory).toBe(generated.archonHome);
      expect(generated.path).toBe(process.env.PATH ?? '');
      expect(generated.output).toBe('discard');
      const directory = await scratchDirectory();
      const { commands, runCommand } = recorder();
      const runtime = {
        platform: 'darwin' as const,
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand,
      };
      const installed = await installNativeSchedule(generated, runtime);
      expect(await readFile(installed.path, 'utf8')).toContain('<string>wake</string>');
      expect(await installNativeSchedule(generated, runtime)).toEqual(installed);
      expect(commands[1]).toEqual([
        '/bin/launchctl',
        'print',
        `gui/501/com.archon.trigger.${originalId}`,
      ]);
      await expect(installNativeSchedule(workflowWakeScheduleConfig(10), runtime)).rejects.toThrow(
        /different configuration.*PATH.*archon workflow wake schedule remove.*install it again/
      );
      expect(await removeNativeSchedule(generated, runtime)).toBe(true);
      expect(commands.at(-1)).toEqual(['/bin/launchctl', 'bootout', 'gui/501', installed.path]);
      expect(await removeNativeSchedule(generated, runtime)).toBe(false);
    }
  );

  it('installs on Windows as a one-minute task whose watcher writes nowhere, and removes only it', async () => {
    const { defaultWakeIntervalSeconds, workflowWakeScheduleConfig } = await import(
      '../commands/wake-schedule'
    );
    const job = {
      ...workflowWakeScheduleConfig(defaultWakeIntervalSeconds('win32')),
      archonHome: await scratchDirectory(),
    };
    const { commands, runCommand } = recorder();
    const win32 = {
      platform: 'win32' as const,
      windowsUserId: 'me',
      windowsLauncher: ['C:\\Program Files\\archon\\archon.exe'] as const,
      runCommand,
    };
    const label = `com.archon.trigger.${job.id}`;
    const task = `\\Archon\\${label}`;
    const schedules = join(job.archonHome, 'schedules');

    const { path } = await installNativeSchedule(job, win32);
    expect(path).toBe(join(schedules, `${label}.xml`));
    expect(commands).toEqual([
      ['schtasks.exe', '/Create', '/TN', task, '/XML', path, '/F'],
      ['schtasks.exe', '/Run', '/TN', task],
    ]);
    const definition = (await readFile(path)).subarray(2).toString('utf16le');
    expect(definition).toContain('<Interval>PT1M</Interval>');
    expect(definition).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(await readFile(join(schedules, `${label}.cmd`), 'utf8')).toContain(
      '"workflow" "wake" "--watch" "--json") >nul 2>&1'
    );
    expect(await inspectNativeSchedule(job, win32)).toMatchObject({ path, registered: true });

    commands.length = 0;
    expect(await removeNativeSchedule(job, win32)).toBe(true);
    expect(commands).toEqual([
      ['schtasks.exe', '/Query', '/TN', task],
      ['schtasks.exe', '/Delete', '/TN', task, '/F'],
    ]);
    expect(await readdir(schedules)).toEqual([]);
  });
});

describe('isolation cleanup native schedule', () => {
  itOnPosixHost(
    'runs the merged cleanup from the Archon home with a log, and status reports it',
    async () => {
      const { isolationCleanupScheduleConfig } = await import('../commands/isolation-schedule');
      const archonHome = await scratchDirectory();
      const generated = isolationCleanupScheduleConfig(undefined, {
        ARCHON_HOME: archonHome,
        PATH: '/usr/bin',
      });
      expect(isolationCleanupScheduleConfig(60, { ARCHON_HOME: archonHome }).id).toBe(generated.id);
      expect(generated.programArguments.slice(-3)).toEqual(['isolation', 'cleanup', '--merged']);
      expect(generated.workingDirectory).toBe(generated.archonHome);
      expect(generated.schedule).toEqual({ intervalSeconds: 21600, runAtLoad: true });
      expect(generated.output).toBe('log');

      const units = await scratchDirectory();
      await mkdir(units, { recursive: true });
      const runtime = {
        platform: 'linux' as const,
        systemdUserDirectory: units,
        runCommand: recorder().runCommand,
      };
      expect(await inspectNativeSchedule(generated, runtime)).toBeUndefined();
      const installed = await installNativeSchedule(generated, runtime);
      expect(await inspectNativeSchedule(generated, runtime)).toMatchObject({
        path: installed.path,
        registered: true,
        log: installed.log,
      });
      expect(await removeNativeSchedule(generated, runtime)).toBe(true);
      expect(await inspectNativeSchedule(generated, runtime)).toBeUndefined();
    }
  );
});
