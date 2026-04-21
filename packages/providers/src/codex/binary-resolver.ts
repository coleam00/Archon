/**
 * Codex binary resolver for compiled (bun --compile) archon binaries.
 *
 * The @openai/codex-sdk uses `createRequire(import.meta.url)` to locate the
 * native Codex CLI binary, which breaks in compiled binaries where
 * `import.meta.url` is frozen to the build host's path.
 *
 * Resolution order:
 * 1. `CODEX_BIN_PATH` environment variable
 * 2. `assistants.codex.codexBinaryPath` in config
 * 3. `~/.archon/vendor/codex/<platform-binary>` (user-placed)
 * 4. Throw with install instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK
 * uses its normal node_modules-based resolution.
 */
import { existsSync as _existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('codex-binary');
  return cachedLog;
}

const CODEX_VENDOR_DIR = 'vendor/codex';

const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

/** Returns the vendor binary filename for the current platform, or undefined if unsupported. */
function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

/**
 * Resolve the path to the Codex native binary.
 *
 * In dev mode: returns undefined (let SDK resolve via node_modules).
 * In binary mode: resolves from env/config/vendor dir, or throws with install instructions.
 */
export async function resolveCodexBinaryPath(
  configCodexBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable override
  const envPath = process.env.CODEX_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `CODEX_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the Codex CLI binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'codex.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configCodexBinaryPath) {
    if (!fileExists(configCodexBinaryPath)) {
      throw new Error(
        `assistants.codex.codexBinaryPath is set to "${configCodexBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the Codex CLI binary.'
      );
    }
    getLog().info({ binaryPath: configCodexBinaryPath, source: 'config' }, 'codex.binary_resolved');
    return configCodexBinaryPath;
  }

  // 3. Check vendor directory (user-placed binary)
  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const archonHome = getArchonHome();
    const vendorBinaryPath = join(archonHome, CODEX_VENDOR_DIR, binaryName);

    if (fileExists(vendorBinaryPath)) {
      getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'codex.binary_resolved');
      return vendorBinaryPath;
    }
  }

  // 4. Not found — throw with install instructions
  const vendorPath = `~/.archon/${CODEX_VENDOR_DIR}/`;
  throw new Error(
    'Codex CLI binary not found. The Codex provider requires a native binary\n' +
      'that cannot be resolved automatically in compiled Archon builds.\n\n' +
      'To fix, choose one of:\n' +
      '  1. Install globally: npm install -g @openai/codex\n' +
      '     Then set: CODEX_BIN_PATH=$(which codex)\n\n' +
      `  2. Place the binary at: ${vendorPath}\n\n` +
      '  3. Set the path in config:\n' +
      '     # .archon/config.yaml\n' +
      '     assistants:\n' +
      '       codex:\n' +
      '         codexBinaryPath: /path/to/codex\n'
  );
}
