import { afterEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  installMacosNativeSchedule,
  removeMacosNativeSchedule,
  renderMacosLaunchAgent,
  type NativeScheduleConfig,
} from './native-schedule';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

function config(overrides: Partial<NativeScheduleConfig> = {}): NativeScheduleConfig {
  return {
    id: 'source-refresh',
    programArguments: ['/opt/archon/bin/archon', 'trigger', 'fire', '--config', '/tmp/a&b.json'],
    workingDirectory: '/Users/example/Project <one>',
    archonHome: '/Users/example/.archon',
    schedule: { intervalSeconds: 37, runAtLoad: false },
    ...overrides,
  };
}

async function scratchDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'archon-native-schedule-'));
  tempRoots.push(path);
  return path;
}

describe('renderMacosLaunchAgent', () => {
  it('renders escaped arguments as an argv array with only ARCHON_HOME in the environment', () => {
    const rendered = renderMacosLaunchAgent(config());

    expect(rendered.label).toBe('com.archon.trigger.source-refresh');
    expect(rendered.plist).toContain('<string>/tmp/a&amp;b.json</string>');
    expect(rendered.plist).toContain('<string>/Users/example/Project &lt;one&gt;</string>');
    expect(rendered.plist).toContain('<key>ARCHON_HOME</key>');
    expect(rendered.plist).toContain('<integer>37</integer>');
    expect(rendered.plist).toContain('<false/>');
    expect(rendered.plist).not.toContain('<key>Program</key>');
    expect(rendered.plist).not.toContain('<key>ShellPath</key>');
  });

  it('rejects settings that cannot be represented by the owned launchd job', () => {
    expect(() => renderMacosLaunchAgent(config({ id: '../other-job' }))).toThrow(
      'Native schedule id must'
    );
    expect(() =>
      renderMacosLaunchAgent(config({ programArguments: ['archon', 'trigger', 'fire'] }))
    ).toThrow('executable must be an absolute path');
    expect(() =>
      renderMacosLaunchAgent(config({ schedule: { intervalSeconds: 0, runAtLoad: false } }))
    ).toThrow('positive integer');
  });

  it.skipIf(process.platform !== 'darwin')('produces a plist accepted by macOS', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'job.plist');
    await writeFile(path, renderMacosLaunchAgent(config()).plist);

    await expect(execFileAsync('/usr/bin/plutil', ['-lint', path])).resolves.toMatchObject({
      stdout: expect.stringContaining('OK'),
    });
  });
});

describe('native schedule installation', () => {
  it('installs and removes only the exact owned launch agent', async () => {
    const directory = await scratchDirectory();
    const commands: Array<{ executable: string; args: readonly string[] }> = [];
    const runCommand = async (executable: string, args: readonly string[]): Promise<void> => {
      commands.push({ executable, args });
    };

    const path = await installMacosNativeSchedule(config(), {
      platform: 'darwin',
      uid: 501,
      launchAgentsDirectory: directory,
      runCommand,
    });

    expect(path).toBe(join(directory, 'com.archon.trigger.source-refresh.plist'));
    expect(await readFile(path, 'utf8')).toBe(renderMacosLaunchAgent(config()).plist);
    expect(commands[0]).toEqual({
      executable: '/bin/launchctl',
      args: ['bootstrap', 'gui/501', path],
    });

    expect(
      await removeMacosNativeSchedule('source-refresh', {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand,
      })
    ).toBe(true);
    expect(commands[1]).toEqual({
      executable: '/bin/launchctl',
      args: ['bootout', 'gui/501', path],
    });
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to replace a different configuration under the same owned id', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');
    await writeFile(path, 'user-owned or stale contents');
    let commandRan = false;

    await expect(
      installMacosNativeSchedule(config(), {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async () => {
          commandRan = true;
        },
      })
    ).rejects.toThrow('Refusing to replace');
    expect(commandRan).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('user-owned or stale contents');
  });

  it('rolls back a newly written plist when launchd rejects installation', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');

    await expect(
      installMacosNativeSchedule(config(), {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async () => {
          throw new Error('bootstrap failed');
        },
      })
    ).rejects.toThrow('bootstrap failed');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the plist when launchd refuses removal', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');
    await writeFile(path, renderMacosLaunchAgent(config()).plist);

    await expect(
      removeMacosNativeSchedule('source-refresh', {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async () => {
          throw new Error('bootout failed');
        },
      })
    ).rejects.toThrow('bootout failed');
    expect(await readFile(path, 'utf8')).toBe(renderMacosLaunchAgent(config()).plist);
  });

  it('rejects installation on unsupported hosts', async () => {
    await expect(installMacosNativeSchedule(config(), { platform: 'linux' })).rejects.toThrow(
      'supported only on macOS'
    );
  });
});
