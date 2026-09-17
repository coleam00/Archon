/**
 * Resolve the official Grok Build CLI. Grok is not bundled with Archon, so
 * this always searches — unlike Copilot, which can skip resolution in dev.
 *
 * Order: GROK_BIN_PATH, assistants.grok.grokBinaryPath, vendor dir,
 * well-known install paths, PATH.
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
import { getArchonHome, createLogger } from '@archon/paths';

export function resolveFromPath(): string | undefined {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = _execFileSync(lookupCmd, ['grok'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = output.split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
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

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('grok-binary');
  return cachedLog;
}

const GROK_VENDOR_DIR = 'vendor/grok';
const INSTALL_HINT =
  'Grok CLI not found. Install Grok Build, then authenticate:\n' +
  '  curl -fsSL https://x.ai/cli/install.sh | bash\n' +
  '  grok login\n\n' +
  'Or set GROK_BIN_PATH / assistants.grok.grokBinaryPath to the grok binary.';

function vendorBinaryName(): string {
  return process.platform === 'win32' ? 'grok.exe' : 'grok';
}

function autodetectPaths(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    return [join(home, '.grok', 'bin', 'grok.exe'), join(home, '.local', 'bin', 'grok.exe')];
  }
  const paths = [
    join(home, '.grok', 'bin', 'grok'),
    join(home, '.local', 'bin', 'grok'),
    '/usr/local/bin/grok',
  ];
  if (process.platform === 'darwin') paths.push('/opt/homebrew/bin/grok');
  return paths;
}

export function resolveGrokBinaryPath(configPath?: string): string {
  const envPath = process.env.GROK_BIN_PATH;
  if (envPath) {
    if (!isExecutableFile(envPath)) {
      throw new Error(
        `GROK_BIN_PATH is set to "${envPath}" but it is not an executable file.\n${INSTALL_HINT}`
      );
    }
    getLog().info({ source: 'env' }, 'grok.binary_resolved');
    return envPath;
  }

  if (configPath) {
    if (!isExecutableFile(configPath)) {
      throw new Error(
        `assistants.grok.grokBinaryPath is set to "${configPath}" but it is not an executable file.\n${INSTALL_HINT}`
      );
    }
    getLog().info({ source: 'config' }, 'grok.binary_resolved');
    return configPath;
  }

  const vendorPath = join(getArchonHome(), GROK_VENDOR_DIR, vendorBinaryName());
  if (isExecutableFile(vendorPath)) {
    getLog().info({ source: 'vendor' }, 'grok.binary_resolved');
    return vendorPath;
  }

  for (const probe of autodetectPaths()) {
    if (isExecutableFile(probe)) {
      getLog().info({ source: 'autodetect' }, 'grok.binary_resolved');
      return probe;
    }
  }

  const fromPath = resolveFromPath();
  if (fromPath && isExecutableFile(fromPath)) {
    getLog().info({ source: 'path' }, 'grok.binary_resolved');
    return fromPath;
  }

  throw new Error(INSTALL_HINT);
}
