/**
 * Qoder CLI binary resolver.
 *
 * Qoder is a user-installed CLI, so unlike SDK-backed providers we always need
 * a spawnable executable in both source and compiled builds.
 */
import {
  accessSync as _accessSync,
  constants as fsConstants,
  existsSync as _existsSync,
  statSync as _statSync,
} from 'node:fs';
import { execFileSync as _execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';

const QODERCLI_VENDOR_DIR = 'vendor/qodercli';
const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('qodercli-binary');
  return cachedLog;
}

export function fileExists(path: string): boolean {
  return _existsSync(path);
}

export function isExecutableFile(path: string): boolean {
  try {
    const stat = _statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    _accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export function resolveFromPath(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = _execFileSync(lookupCmd, ['qodercli'], {
      encoding: 'utf-8',
      env: definedEnv(env),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = output.split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'qodercli.exe' : 'qodercli';
}

function getAutodetectPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'qodercli.cmd'));
    paths.push(join(homedir(), '.local', 'bin', 'qodercli.exe'));
    return paths;
  }

  paths.push(join(homedir(), '.local', 'bin', 'qodercli'));
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/qodercli');
  }
  paths.push('/usr/local/bin/qodercli');
  return paths;
}

function assertExecutable(path: string, sourceLabel: string): string {
  if (!fileExists(path)) {
    throw new Error(
      `${sourceLabel} is set to "${path}" but the file does not exist.\n` +
        'Please verify the path points to the qodercli executable.'
    );
  }
  if (!isExecutableFile(path)) {
    throw new Error(
      `${sourceLabel} is set to "${path}" but it is not an executable file.\n` +
        'Please verify the path points to qodercli and is executable.'
    );
  }
  return path;
}

/**
 * Resolve a spawnable qodercli executable.
 */
export async function resolveQoderCliBinaryPath(
  configBinaryPath?: string,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const envPath = env.QODERCLI_BIN_PATH;
  if (envPath) {
    const resolved = assertExecutable(envPath, 'QODERCLI_BIN_PATH');
    getLog().info({ source: 'env' }, 'qodercli.binary_resolved');
    return resolved;
  }

  if (configBinaryPath) {
    const resolved = assertExecutable(configBinaryPath, 'assistants.qodercli.qodercliBinaryPath');
    getLog().info({ source: 'config' }, 'qodercli.binary_resolved');
    return resolved;
  }

  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const vendorBinaryPath = join(getArchonHome(), QODERCLI_VENDOR_DIR, binaryName);
    if (isExecutableFile(vendorBinaryPath)) {
      getLog().info({ source: 'vendor' }, 'qodercli.binary_resolved');
      return vendorBinaryPath;
    }
  }

  for (const probePath of getAutodetectPaths()) {
    if (isExecutableFile(probePath)) {
      getLog().info({ source: 'autodetect' }, 'qodercli.binary_resolved');
      return probePath;
    }
  }

  const fromPath = resolveFromPath(env);
  if (fromPath && isExecutableFile(fromPath)) {
    getLog().info({ source: 'path' }, 'qodercli.binary_resolved');
    return fromPath;
  }

  throw new Error(
    'Qoder CLI binary not found.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install Qoder CLI and ensure `qodercli` is on PATH.\n' +
      '  2. Set QODERCLI_BIN_PATH=/absolute/path/to/qodercli.\n' +
      '  3. Configure it in ~/.archon/config.yaml:\n' +
      '     assistants:\n' +
      '       qodercli:\n' +
      '         qodercliBinaryPath: /absolute/path/to/qodercli\n'
  );
}
