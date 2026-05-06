/**
 * Copilot CLI binary resolver for compiled (bun --compile) archon binaries.
 *
 * The @github/copilot package bundles a CLI, but in compiled Archon binaries
 * the SDK's path resolution via import.meta.url may fail.
 *
 * Resolution order:
 * 1. `COPILOT_BIN_PATH` environment variable
 * 2. `assistants.copilot.cliPath` in config
 * 3. Autodetect canonical install paths (npm prefix defaults per platform)
 * 4. Throw with install instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK
 * uses its normal bundled CLI resolution.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests. */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('copilot-binary');
  return cachedLog;
}

/**
 * Resolve the path to the Copilot CLI binary.
 *
 * In dev mode: returns undefined (let SDK resolve via bundled CLI).
 * In binary mode: resolves from env/config/autodetect, or throws with install instructions.
 */
export async function resolveCopilotBinaryPath(
  configCliPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable override
  const envPath = process.env.COPILOT_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `COPILOT_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the GitHub Copilot CLI binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'copilot.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configCliPath) {
    if (!fileExists(configCliPath)) {
      throw new Error(
        `assistants.copilot.cliPath is set to "${configCliPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the GitHub Copilot CLI binary.'
      );
    }
    getLog().info({ binaryPath: configCliPath, source: 'config' }, 'copilot.binary_resolved');
    return configCliPath;
  }

  // 3. Autodetect — probe the handful of paths Copilot typically lands at
  const autodetectPaths = getAutodetectPaths();
  for (const probePath of autodetectPaths) {
    if (fileExists(probePath)) {
      getLog().info({ binaryPath: probePath, source: 'autodetect' }, 'copilot.binary_resolved');
      return probePath;
    }
  }

  // 4. Not found — throw with install instructions
  throw new Error(
    'GitHub Copilot CLI binary not found. The Copilot provider requires the CLI\n' +
      'binary that cannot be resolved automatically in compiled Archon builds.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install globally: npm install -g @github/copilot\n' +
      '     Then set: COPILOT_BIN_PATH=$(which copilot)\n\n' +
      '  2. Set the path in config:\n' +
      '     # .archon/config.yaml\n' +
      '     assistants:\n' +
      '       copilot:\n' +
      '         cliPath: /path/to/copilot\n'
  );
}

/**
 * Canonical install locations probed by autodetect. Covers npm global install
 * defaults per platform and common Homebrew paths on macOS.
 */
function getAutodetectPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'copilot.cmd'));
    paths.push(join(homedir(), '.npm-global', 'copilot.cmd'));
    return paths;
  }

  // POSIX (macOS + Linux)
  paths.push(join(homedir(), '.npm-global', 'bin', 'copilot'));
  paths.push(join(homedir(), '.nvm', 'versions', 'node', 'v18.20.1', 'bin', 'copilot'));

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/copilot');
  }

  paths.push('/usr/local/bin/copilot');

  return paths;
}
