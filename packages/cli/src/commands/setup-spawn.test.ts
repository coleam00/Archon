import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import { spawnTerminalWithSetup } from './setup-spawn';
import { setupCommand } from './setup';

const spawner: {
  spawn(
    command: string,
    args: readonly string[],
    options: childProcess.SpawnOptions
  ): childProcess.ChildProcess;
} = childProcess;

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  mock.restore();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function terminalSpawns(successAt: number) {
  const children: childProcess.ChildProcess[] = [];
  const spawn = spyOn(spawner, 'spawn').mockImplementation(() => {
    const child = new childProcess.ChildProcess();
    const attempt = children.length;
    children.push(child);
    spyOn(child, 'unref').mockImplementation(() => undefined);
    setImmediate(() => {
      child.emit(attempt === successAt ? 'spawn' : 'error', new Error('ENOENT'));
    });
    return child;
  });
  return { spawn, children };
}

const repoPath = '/repo with spaces';
const setup = 'archon setup --providers=claude,codex';
const shellSetup = `${setup}; exec bash`;

const platforms = [
  {
    platform: 'win32',
    commands: ['wt.exe', 'cmd.exe'],
    args: [
      ['-d', repoPath, 'cmd', '/k', setup],
      ['/c', 'start', '""', '/D', repoPath, 'cmd', '/k', setup],
    ],
  },
  {
    platform: 'darwin',
    commands: ['osascript'],
    args: [['-e', `tell application "Terminal" to do script "cd '${repoPath}' && ${setup}"`]],
  },
  {
    platform: 'linux',
    commands: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'],
    args: [
      [`--working-directory=${repoPath}`, '-e', `bash -c "${shellSetup}"`],
      [`--working-directory=${repoPath}`, '--', 'bash', '-c', shellSetup],
      ['--workdir', repoPath, '-e', 'bash', '-c', shellSetup],
      ['-e', `cd "${repoPath}" && ${shellSetup}`],
    ],
  },
] as const;

describe('setup terminal spawning', () => {
  for (const { platform, commands, args } of platforms) {
    it(`${platform}: stops after the first successful spawn and unreferences it`, async () => {
      usePlatform(platform);
      const { spawn, children } = terminalSpawns(0);
      expect(await spawnTerminalWithSetup({ repoPath, providers: ['claude', 'codex'] })).toEqual({
        success: true,
      });
      expect(spawn.mock.calls.map(call => call[0])).toEqual([commands[0]]);
      expect(spawn.mock.calls[0]?.[2]).toEqual({ detached: true, stdio: 'ignore' });
      expect(spawn.mock.calls[0]?.[1]).toEqual(args[0]);
      expect(children[0]?.unref).toHaveBeenCalledTimes(1);
    });

    it(`${platform}: handles asynchronous errors from every missing terminal`, async () => {
      usePlatform(platform);
      const { spawn, children } = terminalSpawns(-1);
      const result = await spawnTerminalWithSetup({ repoPath: '/repo' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Please run `archon setup` manually.');
      expect(spawn.mock.calls.map(call => call[0])).toEqual([...commands]);
      for (const child of children) expect(child.unref).not.toHaveBeenCalled();
    });

    for (let successAt = 1; successAt < commands.length; successAt++) {
      it(`${platform}: falls back through asynchronous errors to ${commands[successAt]}`, async () => {
        usePlatform(platform);
        const { spawn, children } = terminalSpawns(successAt);
        expect(await spawnTerminalWithSetup({ repoPath, providers: ['claude', 'codex'] })).toEqual({
          success: true,
        });
        expect(spawn.mock.calls.map(call => call[0])).toEqual(commands.slice(0, successAt + 1));
        expect(spawn.mock.calls.map(call => call[1])).toEqual(args.slice(0, successAt + 1));
        for (const call of spawn.mock.calls)
          expect(call[2]).toEqual({ detached: true, stdio: 'ignore' });
        for (const child of children.slice(0, successAt))
          expect(child.unref).not.toHaveBeenCalled();
        expect(children[successAt]?.unref).toHaveBeenCalledTimes(1);
      });
    }
  }

  it('falls back when spawn throws synchronously', async () => {
    usePlatform('win32');
    const { spawn } = terminalSpawns(0);
    spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(await spawnTerminalWithSetup({ repoPath: '/repo' })).toEqual({ success: true });
    expect(spawn.mock.calls.map(call => call[0])).toEqual(['wt.exe', 'cmd.exe']);
  });

  it('rejects invalid providers before spawning', async () => {
    const { spawn } = terminalSpawns(0);
    await expect(
      async () => await spawnTerminalWithSetup({ repoPath: '/repo', providers: ['invalid'] })
    ).toThrow('Invalid setup provider selection');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([0, 1, -1])('setup reports the final launch outcome (%s)', async successAt => {
    usePlatform('win32');
    const repoPath = 'D:\\repo with spaces';
    const { spawn } = terminalSpawns(successAt);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await setupCommand({
        spawn: true,
        repoPath,
        providers: ['codex'],
        scope: 'project',
        force: true,
      })
    ).toBe(0);
    const command = 'archon setup --providers=codex --scope=project --force';
    expect(spawn.mock.calls[0]?.[1]).toEqual(['-d', repoPath, 'cmd', '/k', command]);
    if (successAt !== 0) {
      expect(spawn.mock.calls[1]?.[1]).toEqual([
        '/c',
        'start',
        '""',
        '/D',
        repoPath,
        'cmd',
        '/k',
        command,
      ]);
    }
    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    if (successAt === -1) {
      expect(output).toContain('Next step: run the setup wizard in Command Prompt (cmd.exe).');
      expect(output).toContain(`cd /d "${repoPath}" && ${command}`);
      expect(output).not.toContain('Setup wizard opened.');
    } else {
      expect(output).toContain('Setup wizard opened.');
      expect(output).not.toContain('Next step:');
    }
  });

  it.each(['darwin', 'linux'] as const)(
    '%s: manual guidance quotes the repository path for the shell',
    async platform => {
      usePlatform(platform);
      terminalSpawns(-1);
      const log = spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await setupCommand({ spawn: true, repoPath: "/repo's path with spaces" })).toBe(0);
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('Next step: run the setup wizard in a separate terminal.');
      expect(output).toContain(`cd '/repo'"'"'s path with spaces' && archon setup`);
    }
  );

  it.each([false, true])(
    'setup handles real missing executables with fallback available: %s',
    async fallbackAvailable => {
      usePlatform('win32');
      const realSpawn = childProcess.spawn;
      let attempt = 0;
      const spawn = spyOn(spawner, 'spawn').mockImplementation((_command, _args, options) => {
        const succeeds = attempt++ === 1 && fallbackAvailable;
        return succeeds
          ? realSpawn(process.execPath, ['-e', ''], options)
          : realSpawn('/archon-nonexistent-terminal/terminal', [], options);
      });
      const log = spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await setupCommand({ spawn: true, repoPath: '/repo' })).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      const output = log.mock.calls.flat().join('\n');
      if (fallbackAvailable) {
        expect(output).toContain('Setup wizard opened.');
      } else {
        expect(output).toContain('cd /d "/repo" && archon setup');
        expect(output).not.toContain('Setup wizard opened.');
      }
    }
  );
});
