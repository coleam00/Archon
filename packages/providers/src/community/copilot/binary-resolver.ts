import { existsSync as _existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('copilot-binary');
  return cachedLog;
}

const COPILOT_VENDOR_DIR = 'vendor/copilot';

function resolveFromPath(): string | undefined {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const executable = process.platform === 'win32' ? 'copilot.exe' : 'copilot';

  try {
    const output = execFileSync(whichCmd, [executable], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = output.split(/\r?\n/)[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

function getVendorBinaryName(): string | undefined {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'copilot.exe' : 'copilot';
}

const INSTALL_INSTRUCTIONS =
  'GitHub Copilot CLI was not found.\n\n' +
  'To fix, choose one of:\n' +
  '  1. Install globally: npm install -g @github/copilot\n' +
  '     Then set: COPILOT_CLI_PATH=$(which copilot)\n\n' +
  '  2. Persist the path in ~/.archon/config.yaml:\n' +
  '     assistants:\n' +
  '       copilot:\n' +
  '         copilotCliPath: /absolute/path/to/copilot\n\n' +
  '  3. Place the binary under ~/.archon/vendor/copilot/\n\n' +
  '  4. Or, if you are running from source, install @github/copilot-sdk deps with bun install.\n';

/**
 * Resolve the Copilot CLI path.
 *
 * In dev mode, explicit env/config/path overrides are honored, otherwise the
 * SDK can use its own bundled CLI from node_modules.
 *
 * In compiled Archon binaries, automatic node_modules resolution is unavailable,
 * so we must resolve a real executable path or fail loudly.
 */
export async function resolveCopilotCliPath(
  configCopilotCliPath?: string
): Promise<string | undefined> {
  const envPath = process.env.COPILOT_CLI_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `COPILOT_CLI_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the Copilot CLI executable.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'copilot.binary_resolved');
    return envPath;
  }

  if (configCopilotCliPath) {
    if (!fileExists(configCopilotCliPath)) {
      throw new Error(
        `assistants.copilot.copilotCliPath is set to "${configCopilotCliPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the Copilot CLI executable.'
      );
    }
    getLog().info(
      { binaryPath: configCopilotCliPath, source: 'config' },
      'copilot.binary_resolved'
    );
    return configCopilotCliPath;
  }

  if (BUNDLED_IS_BINARY) {
    const vendorBinaryName = getVendorBinaryName();
    if (vendorBinaryName) {
      const vendorBinaryPath = join(getArchonHome(), COPILOT_VENDOR_DIR, vendorBinaryName);
      if (fileExists(vendorBinaryPath)) {
        getLog().info(
          { binaryPath: vendorBinaryPath, source: 'vendor' },
          'copilot.binary_resolved'
        );
        return vendorBinaryPath;
      }
    }
  }

  const fromPath = resolveFromPath();
  if (fromPath && fileExists(fromPath)) {
    getLog().info({ binaryPath: fromPath, source: 'path' }, 'copilot.binary_resolved');
    return fromPath;
  }

  if (!BUNDLED_IS_BINARY) return undefined;

  throw new Error(INSTALL_INSTRUCTIONS);
}
