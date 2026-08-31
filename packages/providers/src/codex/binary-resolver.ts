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
 * 4. Autodetect canonical install paths (npm prefix defaults per platform)
 * 5. Throw with install instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK
 * uses its normal node_modules-based resolution.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';
import {
  appendBinaryCandidateHint,
  classifyBinaryPath,
  type BinaryPathKind,
} from '../shared/binary-resolution';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

export function pathKind(path: string): BinaryPathKind {
  return classifyBinaryPath(path, error => {
    getLog().warn({ err: error, path, code: error.code }, 'codex.path_stat_failed');
  });
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('codex-binary');
  return cachedLog;
}

const CODEX_VENDOR_DIR = 'vendor/codex';

const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'];

const CODEX_BINARY_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** Which resolution tier produced the Codex binary path. */
export type CodexBinarySource = 'env' | 'config' | 'vendor' | 'autodetect';

interface CodexBinaryResolution {
  path: string;
  source: CodexBinarySource;
}

interface CodexBinaryPin {
  sourceLabel: string;
  removableSetting: string;
  missingInstruction: string;
}

const CODEX_ENV_PIN: CodexBinaryPin = {
  sourceLabel: 'CODEX_BIN_PATH',
  removableSetting: 'CODEX_BIN_PATH',
  missingInstruction: 'Please verify the path points to the Codex CLI binary.',
};

const CODEX_CONFIG_PIN: CodexBinaryPin = {
  sourceLabel: 'assistants.codex.codexBinaryPath',
  removableSetting: 'codexBinaryPath',
  missingInstruction:
    'Please verify the path in .archon/config.yaml points to the Codex CLI binary.',
};

/** Returns the vendor binary filename for the current platform, or undefined if unsupported. */
function getVendorBinaryName(): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return undefined;
  return CODEX_BINARY_NAME;
}

function findLowerTierBinary(): CodexBinaryResolution | undefined {
  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const vendorBinaryPath = join(getArchonHome(), CODEX_VENDOR_DIR, binaryName);
    if (pathKind(vendorBinaryPath) === 'file') {
      return { path: vendorBinaryPath, source: 'vendor' };
    }
  }

  for (const probePath of getAutodetectPaths()) {
    if (pathKind(probePath) === 'file') {
      return { path: probePath, source: 'autodetect' };
    }
  }

  return undefined;
}

function validateAndExpand(rawPath: string, pin: CodexBinaryPin): string {
  const kind = pathKind(rawPath);
  if (kind === 'file') return rawPath;

  let message: string;
  if (kind === 'directory') {
    const executablePath = join(rawPath, CODEX_BINARY_NAME);
    if (pathKind(executablePath) === 'file') return executablePath;
    message =
      `${pin.sourceLabel} is set to "${rawPath}", which is a directory, but it does not contain ${CODEX_BINARY_NAME}.\n` +
      'Please point this setting at the Codex CLI binary itself.';
  } else {
    message =
      `${pin.sourceLabel} is set to "${rawPath}" but the file does not exist.\n` +
      pin.missingInstruction;
  }

  const candidate = findLowerTierBinary();
  throw new Error(
    appendBinaryCandidateHint(message, {
      candidatePath: candidate?.path,
      binaryLabel: 'Codex',
      sourceLabel: pin.sourceLabel,
      removableSetting: pin.removableSetting,
    })
  );
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
  const resolved = await resolveCodexBinaryWithSource(configCodexBinaryPath);
  return resolved?.path;
}

/**
 * Same resolution as {@link resolveCodexBinaryPath}, but also reports which
 * tier produced the path. Used by `archon doctor` to tell the user how the
 * binary was found (env / config / vendor / autodetect). Returns undefined in
 * dev mode; throws with install instructions in binary mode when unresolved.
 */
export async function resolveCodexBinaryWithSource(
  configCodexBinaryPath?: string
): Promise<CodexBinaryResolution | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable override
  const envPath = process.env.CODEX_BIN_PATH;
  if (envPath) {
    const resolvedEnv = validateAndExpand(envPath, CODEX_ENV_PIN);
    getLog().info({ binaryPath: resolvedEnv, source: 'env' }, 'codex.binary_resolved');
    return { path: resolvedEnv, source: 'env' };
  }

  // 2. Config file override
  if (configCodexBinaryPath) {
    const resolvedConfig = validateAndExpand(configCodexBinaryPath, CODEX_CONFIG_PIN);
    getLog().info({ binaryPath: resolvedConfig, source: 'config' }, 'codex.binary_resolved');
    return { path: resolvedConfig, source: 'config' };
  }

  // 3-4. Vendor then autodetect. The same search supplies diagnostics for an
  // invalid explicit pin, but a candidate is returned only when no pin exists.
  const lowerTierBinary = findLowerTierBinary();
  if (lowerTierBinary) {
    getLog().info(
      { binaryPath: lowerTierBinary.path, source: lowerTierBinary.source },
      'codex.binary_resolved'
    );
    return lowerTierBinary;
  }

  // 5. Not found — throw with install instructions
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

/**
 * Canonical install locations probed by tier 4 autodetect. Grounded in
 * the official @openai/codex README and the npm global-install contract
 * (npm writes the binary to `{npm_prefix}/bin/<name>` on POSIX and
 * `{npm_prefix}\<name>.cmd` on Windows). The probes cover the npm prefix
 * a default install lands at on each platform:
 *
 *  - `$HOME/.npm-global/bin/codex` — common when the user ran
 *    `npm config set prefix ~/.npm-global` to avoid root writes
 *  - `/opt/homebrew/bin/codex` — mac Apple Silicon with homebrew-node
 *    (homebrew sets npm prefix to /opt/homebrew)
 *  - `/usr/local/bin/codex` — mac Intel with homebrew-node, or linux
 *    with system-installed node (npm prefix defaults to /usr/local)
 *  - `%AppData%\npm\codex.cmd` — Windows npm global default
 *
 * Not covered (explicit override required via CODEX_BIN_PATH or config):
 *   - users with other custom npm prefixes — `npm root -g` would spawn
 *     a subprocess per resolve, too heavy for a probe helper
 *   - Homebrew cask install (`brew install --cask codex`) — cask layout
 *     isn't a PATH binary; users should symlink or set the path
 *   - manual GitHub Releases extract — placement is user-determined
 */
function getAutodetectPaths(): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'codex.cmd'));
    paths.push(join(homedir(), '.npm-global', 'codex.cmd'));
    return paths;
  }

  // POSIX (macOS + Linux)
  paths.push(join(homedir(), '.npm-global', 'bin', 'codex'));

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/codex');
  }

  paths.push('/usr/local/bin/codex');

  return paths;
}
