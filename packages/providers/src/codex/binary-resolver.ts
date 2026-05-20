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
import {
  closeSync,
  constants as fsConstants,
  existsSync as _existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as _readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Wrapper for readFileSync — enables spyOn in tests. */
export function readFile(path: string): Buffer {
  return _readFileSync(path);
}

const CODEX_TRUST_DIR = 'trust/codex';

/**
 * In-process cache of verified binary identities.
 *
 * `verifyOrPinBinaryHash` is called from `resolveCodexBinaryPath`, which
 * `createCodexClient` invokes per request when a custom `requestEnv` is
 * supplied. Without any caching, a successful TOFU pin would still re-read and
 * re-hash the entire Codex binary on every call (tens of MB → noticeable
 * latency + buffer churn).
 *
 * Keyed by *logical* path (`resolvePath(binaryPath)`), the same path
 * `getHashPinPath` keys pin files on, so two different logical paths that
 * happen to share a realpath each get their own cache miss + pin
 * verification. Otherwise an attacker who repointed logical path B at a
 * different binary after path A had warmed the cache would slip past the
 * pinning guarantee.
 *
 * The fingerprint stored alongside includes (`realpath`, `ino`, `dev`,
 * `ctimeMs`, `mtimeMs`, `size`):
 *   - `realpath` swap (symlink retargeting) misses the cache.
 *   - `ino + dev` change on any `mv -f` / `rename` swap, even with same
 *     contents and timestamps.
 *   - `ctimeMs` updates whenever the inode metadata changes (chmod/chown/link)
 *     and is not settable from userspace via standard syscalls — non-root
 *     attackers can't roll it back.
 *   - `mtime` and `size` catch the obvious in-place rewrites.
 * A miss on any field forces a fresh hash + pin verification on the next call.
 */
interface VerifiedFingerprint {
  realpath: string;
  ino: number;
  dev: number;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
}
const verifiedFingerprints = new Map<string, VerifiedFingerprint>();

/** Test-only escape hatch — clears the in-process verification cache. */
export function resetVerifiedHashCacheForTests(): void {
  verifiedFingerprints.clear();
}

function isValidSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function getHashPinPath(binaryPath: string): string {
  // Pin by the *logical* path — never realpath. The threat model assumes the
  // attacker can write the binary's directory (e.g. `~/.archon/vendor/codex/`).
  // If we keyed pins by realpath, an attacker who swapped a symlink target to
  // point at a different file would resolve to a different realpath, miss the
  // existing pin, and silently get a fresh "first-use" pin. Keying by where
  // Archon *expects* the binary to live forces a pin-existence check on every
  // load, so any swap of contents or symlink target trips a mismatch.
  const logicalPath = resolvePath(binaryPath);
  const pinName = createHash('sha256').update(logicalPath).digest('hex') + '.sha256';
  return join(getArchonHome(), CODEX_TRUST_DIR, pinName);
}

function readPinnedHash(hashPath: string): string {
  const stats = lstatSync(hashPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Codex binary hash pin path is a symlink: ${hashPath}`);
  }

  const expected = readFile(hashPath).toString('utf-8').trim();
  if (!isValidSha256Hex(expected)) {
    throw new Error(
      `Codex binary hash pin file is malformed: ${hashPath}. Delete it and re-run to re-pin.`
    );
  }

  return expected;
}

/**
 * Verify a binary's SHA-256 against a pinned hash, or pin on first use.
 *
 * On first resolution: computes SHA-256 and writes it to a `.sha256` sidecar file.
 * On subsequent loads: verifies the binary matches the pinned hash.
 * Throws if the hash doesn't match (possible tampering).
 *
 * Exported for test spyability (same pattern as fileExists).
 */
export function verifyOrPinBinaryHash(binaryPath: string): void {
  // Cache key is the *logical* path so each distinct caller path (env var,
  // config, vendor, autodetect) gets its own pin verification — even when two
  // logical paths resolve to the same realpath. Realpath is folded into the
  // fingerprint so a symlink retargeting on the same logical path also misses.
  const logicalPath = resolvePath(binaryPath);
  let stat: VerifiedFingerprint | undefined;
  try {
    const realpath = realpathSync(binaryPath);
    const s = statSync(realpath);
    stat = {
      realpath,
      ino: s.ino,
      dev: s.dev,
      ctimeMs: s.ctimeMs,
      mtimeMs: s.mtimeMs,
      size: s.size,
    };
  } catch {
    stat = undefined;
  }
  if (stat) {
    const cached = verifiedFingerprints.get(logicalPath);
    if (
      cached?.realpath === stat.realpath &&
      cached.ino === stat.ino &&
      cached.dev === stat.dev &&
      cached.ctimeMs === stat.ctimeMs &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return;
    }
  }

  const hashPath = getHashPinPath(binaryPath);
  const actual = createHash('sha256').update(readFile(binaryPath)).digest('hex');

  if (fileExists(hashPath)) {
    const expected = readPinnedHash(hashPath);
    if (actual !== expected) {
      getLog().error({ binaryPath, hashPath, expected, actual }, 'codex.binary_hash_mismatch');
      throw new Error(
        'Codex binary hash mismatch — possible tampering detected.\n' +
          `  binary:   ${binaryPath}\n` +
          `  pin file: ${hashPath}\n` +
          `  actual:   ${actual}\n\n` +
          'If you intentionally updated the binary, delete the pin file and re-run to re-pin.'
      );
    }
    getLog().debug({ binaryPath, hash: actual, hashPath }, 'codex.binary_hash_verified');
    if (stat) verifiedFingerprints.set(logicalPath, stat);
  } else {
    try {
      mkdirSync(dirname(hashPath), { recursive: true, mode: 0o700 });
      // O_NOFOLLOW is undefined on Windows, so the open() guard silently
      // disappears there. lstat the pin path first and refuse anything that
      // already exists as a symlink — mirrors readPinnedHash's symlink check
      // and keeps write-path protection on platforms without O_NOFOLLOW.
      try {
        if (lstatSync(hashPath).isSymbolicLink()) {
          throw new Error(`Codex binary hash pin path is a symlink: ${hashPath}`);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const fd = openSync(
        hashPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      try {
        writeSync(fd, actual + '\n');
      } finally {
        closeSync(fd);
      }
      getLog().info({ binaryPath, hash: actual, hashPath }, 'codex.binary_hash_pinned');
      if (stat) verifiedFingerprints.set(logicalPath, stat);
    } catch (err) {
      // Non-fatal — warn but don't block resolution if we can't write the pin file
      getLog().warn({ err, binaryPath, hashPath }, 'codex.binary_hash_pin_write_failed');
    }
  }
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
    verifyOrPinBinaryHash(envPath);
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
    verifyOrPinBinaryHash(configCodexBinaryPath);
    getLog().info({ binaryPath: configCodexBinaryPath, source: 'config' }, 'codex.binary_resolved');
    return configCodexBinaryPath;
  }

  // 3. Check vendor directory (user-placed binary)
  const binaryName = getVendorBinaryName();
  if (binaryName) {
    const archonHome = getArchonHome();
    const vendorBinaryPath = join(archonHome, CODEX_VENDOR_DIR, binaryName);

    if (fileExists(vendorBinaryPath)) {
      verifyOrPinBinaryHash(vendorBinaryPath);
      getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'codex.binary_resolved');
      return vendorBinaryPath;
    }
  }

  // 4. Autodetect — probe the handful of paths Codex typically lands at
  // when installed via the documented package managers. Users who install
  // somewhere else (custom npm prefix, etc.) still set one of the higher-
  // priority sources above. Order: most specific → least specific.
  const autodetectPaths = getAutodetectPaths();
  for (const probePath of autodetectPaths) {
    if (fileExists(probePath)) {
      // Same TOFU pin/verify as the other tiers — autodetected paths are still
      // attacker-writable in many setups (`~/.npm-global/bin`, custom Homebrew
      // prefixes, etc.), so skipping verification here would create a clean
      // bypass of the integrity check.
      verifyOrPinBinaryHash(probePath);
      getLog().info({ binaryPath: probePath, source: 'autodetect' }, 'codex.binary_resolved');
      return probePath;
    }
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
