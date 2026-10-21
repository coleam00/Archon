/**
 * The `--spawn` path of `archon setup`: opening the wizard in a new terminal
 * window on Windows, macOS or Linux.
 */
import { spawn } from 'child_process';
import { isMaintainedProvider } from '@archon/provider-contract';
import type { SetupOptions } from './setup-shared';

interface SpawnResult {
  success: boolean;
  error?: string;
}

async function trySpawn(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv | undefined }
): Promise<boolean> {
  try {
    return await new Promise<boolean>(resolve => {
      const child = spawn(command, args, options);
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}

/**
 * Spawn a new terminal window with the setup command on Windows
 * Tries: Windows Terminal -> cmd.exe with start
 */
async function spawnWindowsTerminal(
  repoPath: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<SpawnResult> {
  // Try Windows Terminal first (modern Windows 10/11)
  if (
    await trySpawn('wt.exe', ['-d', repoPath, 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
      env,
    })
  ) {
    return { success: true };
  }

  // Fallback to cmd.exe with start command (works on all Windows)
  if (
    await trySpawn('cmd.exe', ['/c', 'start', '""', '/D', repoPath, 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
      env,
    })
  ) {
    return { success: true };
  }

  return { success: false, error: 'Could not open terminal. Please run `archon setup` manually.' };
}

/**
 * Spawn terminal on macOS
 * Uses osascript to open Terminal.app (works with default terminal)
 */
async function spawnMacTerminal(
  repoPath: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<SpawnResult> {
  const shellCommand = `cd '${repoPath.replaceAll("'", "'\"'\"'")}' && ${command}`;
  const appleScriptString = shellCommand.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = `tell application "Terminal" to do script "${appleScriptString}"`;

  if (await trySpawn('osascript', ['-e', script], { detached: true, stdio: 'ignore', env })) {
    return { success: true };
  }

  return { success: false, error: 'Could not open Terminal. Please run `archon setup` manually.' };
}

/**
 * Spawn terminal on Linux
 * Tries: x-terminal-emulator -> gnome-terminal -> konsole -> xterm
 */
async function spawnLinuxTerminal(
  repoPath: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<SpawnResult> {
  const setupCmd = `${command}; exec bash`;

  // Try x-terminal-emulator first (Debian/Ubuntu default)
  if (
    await trySpawn(
      'x-terminal-emulator',
      ['--working-directory=' + repoPath, '-e', `bash -c "${setupCmd}"`],
      {
        detached: true,
        stdio: 'ignore',
        env,
      }
    )
  ) {
    return { success: true };
  }

  // Try gnome-terminal (GNOME)
  if (
    await trySpawn(
      'gnome-terminal',
      ['--working-directory=' + repoPath, '--', 'bash', '-c', setupCmd],
      {
        detached: true,
        stdio: 'ignore',
        env,
      }
    )
  ) {
    return { success: true };
  }

  // Try konsole (KDE)
  if (
    await trySpawn('konsole', ['--workdir', repoPath, '-e', 'bash', '-c', setupCmd], {
      detached: true,
      stdio: 'ignore',
      env,
    })
  ) {
    return { success: true };
  }

  // Try xterm (fallback, available on most systems)
  if (
    await trySpawn(
      'xterm',
      ['-e', 'bash', '-c', `cd -- "$1" && ${setupCmd}`, 'archon-setup', repoPath],
      {
        detached: true,
        stdio: 'ignore',
        env,
      }
    )
  ) {
    return { success: true };
  }

  return {
    success: false,
    error: 'Could not find a terminal emulator. Please run `archon setup` manually.',
  };
}

type SetupLaunchOptions = Pick<
  SetupOptions,
  'repoPath' | 'providers' | 'scope' | 'force' | 'inheritedEnv'
>;

export function setupLaunchCommand({ providers, scope, force }: SetupLaunchOptions): string {
  if (providers?.some(id => !isMaintainedProvider(id)))
    throw new Error('Invalid setup provider selection');
  return [
    'archon setup',
    ...(providers === undefined ? [] : [`--providers=${providers.join(',')}`]),
    ...(scope === undefined ? [] : [`--scope=${scope}`]),
    ...(force ? ['--force'] : []),
  ].join(' ');
}

/**
 * Spawn a new terminal window with archon setup
 */
export async function spawnTerminalWithSetup(options: SetupLaunchOptions): Promise<SpawnResult> {
  const { repoPath, inheritedEnv } = options;
  const command = setupLaunchCommand(options);
  const platform = process.platform;

  if (platform === 'win32') {
    return spawnWindowsTerminal(repoPath, command, inheritedEnv);
  } else if (platform === 'darwin') {
    return spawnMacTerminal(repoPath, command, inheritedEnv);
  } else {
    return spawnLinuxTerminal(repoPath, command, inheritedEnv);
  }
}
