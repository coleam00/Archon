/**
 * gemini-cli binary resolver for compiled (bun --compile) Archon binaries.
 *
 * The @lrilai/gemini-cli-sdk shells out to a separately-installed `gemini-cli`
 * binary and resolves it from PATH by default. In compiled Archon builds PATH
 * resolution is unreliable, so this mirrors codex/binary-resolver.ts and feeds
 * the result into the SDK's `QueryOptions.cliPath`.
 *
 * Resolution order:
 *   1. `GEMINI_BIN_PATH` environment variable
 *   2. `assistants.gemini.geminiBinaryPath` in config (passed in)
 *   3. `~/.archon/vendor/gemini/<binary>` (user-placed)
 *   4. Autodetect canonical npm-global install paths
 *   5. Throw with install instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false) returns undefined so the SDK uses its
 * normal PATH resolution.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('gemini-binary');
  return cachedLog;
}

const GEMINI_VENDOR_DIR = 'vendor/gemini';

/**
 * Resolve the path to the gemini-cli binary.
 *
 * In dev mode: returns undefined (SDK resolves via PATH).
 * In binary mode: resolves from env/config/vendor/autodetect, or throws.
 */
export async function resolveGeminiBinaryPath(
  configGeminiBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable override
  const envPath = process.env.GEMINI_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `GEMINI_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the gemini-cli binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'gemini.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configGeminiBinaryPath) {
    if (!fileExists(configGeminiBinaryPath)) {
      throw new Error(
        `assistants.gemini.geminiBinaryPath is set to "${configGeminiBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the gemini-cli binary.'
      );
    }
    getLog().info(
      { binaryPath: configGeminiBinaryPath, source: 'config' },
      'gemini.binary_resolved'
    );
    return configGeminiBinaryPath;
  }

  // 3. Vendor directory (user-placed binary)
  const binaryName = process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
  const vendorBinaryPath = join(getArchonHome(), GEMINI_VENDOR_DIR, binaryName);
  if (fileExists(vendorBinaryPath)) {
    getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'gemini.binary_resolved');
    return vendorBinaryPath;
  }

  // 4. Autodetect canonical install paths
  for (const probePath of getAutodetectPaths()) {
    if (fileExists(probePath)) {
      getLog().info({ binaryPath: probePath, source: 'autodetect' }, 'gemini.binary_resolved');
      return probePath;
    }
  }

  // 5. Not found — throw with install instructions
  throw new Error(
    'gemini-cli binary not found. The Gemini provider requires a native binary\n' +
      'that cannot be resolved automatically in compiled Archon builds.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install globally: npm install -g @google/gemini-cli\n' +
      '     Then set: GEMINI_BIN_PATH=$(which gemini)\n\n' +
      `  2. Place the binary at: ~/.archon/${GEMINI_VENDOR_DIR}/\n\n` +
      '  3. Set the path in config:\n' +
      '     # .archon/config.yaml\n' +
      '     assistants:\n' +
      '       gemini:\n' +
      '         geminiBinaryPath: /path/to/gemini\n'
  );
}

/**
 * Canonical npm-global install locations probed by tier-4 autodetect. Mirrors
 * the codex resolver: npm writes `{prefix}/bin/<name>` on POSIX and
 * `{prefix}\<name>.cmd` on Windows. Users with other prefixes set an explicit
 * override via GEMINI_BIN_PATH or config.
 */
function getAutodetectPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'gemini.cmd'));
    paths.push(join(homedir(), '.npm-global', 'gemini.cmd'));
    return paths;
  }

  paths.push(join(homedir(), '.npm-global', 'bin', 'gemini'));

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/gemini');
  }

  paths.push('/usr/local/bin/gemini');

  return paths;
}
