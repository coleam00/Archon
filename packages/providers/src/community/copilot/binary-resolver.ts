/**
 * Copilot CLI binary resolver for compiled (bun --compile) archon binaries.
 *
 * The @github/copilot-sdk bundles @github/copilot (the CLI) as a transitive
 * dep, and by default the SDK resolves the binary from its own bundled copy
 * via `import.meta.url`. In compiled archon binaries that path is frozen to
 * the build host's filesystem, so we resolve explicitly and pass the result
 * via `new CopilotClient({ cliPath })`.
 *
 * Resolution order:
 *  1. `COPILOT_BIN_PATH` environment variable
 *  2. `assistants.copilot.cliPath` in config
 *  3. `~/.archon/vendor/copilot/<platform-binary>` (user-placed)
 *  4. Autodetect canonical install paths (npm prefix defaults per platform)
 *  5. Throw with install instructions
 *
 * In dev mode (`BUNDLED_IS_BINARY=false`) this returns undefined and lets
 * the SDK find its own bundled CLI via `node_modules/.bin/copilot`. Mirrors
 * `codex/binary-resolver.ts` and `claude/binary-resolver.ts`.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('copilot-binary');
  return cachedLog;
}

const COPILOT_VENDOR_DIR = 'vendor/copilot';
const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'copilot.exe' : 'copilot';
}

/**
 * Resolve the path to the Copilot CLI binary.
 *
 * In dev mode: returns undefined (SDK resolves via its bundled CLI).
 * In binary mode: env / config / vendor / autodetect, else throw.
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
          'Please verify the path points to the Copilot CLI binary.'
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
          'Please verify the path in .archon/config.yaml points to the Copilot CLI binary.'
      );
    }
    getLog().info({ binaryPath: configCliPath, source: 'config' }, 'copilot.binary_resolved');
    return configCliPath;
  }

  // 3. Vendor directory (user-placed)
  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const archonHome = getArchonHome();
    const vendorBinaryPath = join(archonHome, COPILOT_VENDOR_DIR, binaryName);
    if (fileExists(vendorBinaryPath)) {
      getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'copilot.binary_resolved');
      return vendorBinaryPath;
    }
  }

  // 4. Autodetect canonical install paths
  const autodetectPaths = getAutodetectPaths();
  for (const probePath of autodetectPaths) {
    if (fileExists(probePath)) {
      getLog().info({ binaryPath: probePath, source: 'autodetect' }, 'copilot.binary_resolved');
      return probePath;
    }
  }

  // 5. Not found — throw with install instructions
  const vendorPath = `~/.archon/${COPILOT_VENDOR_DIR}/`;
  throw new Error(
    'Copilot CLI binary not found. The Copilot provider requires the\n' +
      '@github/copilot CLI, which cannot be resolved automatically in\n' +
      'compiled Archon builds.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install globally: npm install -g @github/copilot\n' +
      '     Then set: COPILOT_BIN_PATH=$(which copilot)\n\n' +
      `  2. Place the binary at: ${vendorPath}\n\n` +
      '  3. Set the path in config:\n' +
      '     # .archon/config.yaml\n' +
      '     assistants:\n' +
      '       copilot:\n' +
      '         cliPath: /path/to/copilot\n'
  );
}

/**
 * Canonical install locations probed by tier 4 autodetect. Grounded in
 * npm's global-install contract (the binary lands at `{npm_prefix}/bin/<name>`
 * on POSIX, `{npm_prefix}\<name>.cmd` on Windows).
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

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/copilot');
  }

  paths.push('/usr/local/bin/copilot');

  return paths;
}
