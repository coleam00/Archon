/**
 * Codex binary resolver for compiled (bun --compile) archon binaries.
 *
 * The @openai/codex-sdk uses `createRequire(import.meta.url)` to locate the
 * native Codex CLI binary, which breaks in compiled binaries where
 * `import.meta.url` is frozen to the build host's path.
 *
 * This module resolves an alternative path and passes it to the SDK's
 * `codexPathOverride` constructor option, bypassing the broken resolution.
 *
 * Resolution order:
 * 1. `CODEX_BIN_PATH` environment variable
 * 2. `assistants.codex.codexBinaryPath` in config
 * 3. `~/.archon/vendor/codex/<platform-binary>` (auto-downloaded)
 * 4. Throw with clear instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK
 * uses its normal node_modules-based resolution.
 */
import { existsSync as _existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

/**
 * Platform key → target triple → npm version tag suffix → binary subpath.
 * Mirrors @openai/codex-sdk's PLATFORM_PACKAGE_BY_TARGET.
 */
interface PlatformInfo {
  triple: string;
  npmTag: string;
  binarySubpath: string;
}

const PLATFORM_MAP: Record<string, PlatformInfo> = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    npmTag: 'darwin-arm64',
    binarySubpath: 'aarch64-apple-darwin/codex/codex',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    npmTag: 'darwin-x64',
    binarySubpath: 'x86_64-apple-darwin/codex/codex',
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-musl',
    npmTag: 'linux-arm64',
    binarySubpath: 'aarch64-linux-gnu/codex/codex',
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-musl',
    npmTag: 'linux-x64',
    binarySubpath: 'x86_64-linux-gnu/codex/codex',
  },
};

function getPlatformKey(): string {
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  return `${process.platform}-${arch}`;
}

/**
 * Get the installed @openai/codex-sdk version to match the binary download.
 * Reads the SDK's package.json to find its @openai/codex dependency version.
 */
function getCodexSdkVersion(): string {
  try {
    // Resolve the SDK's package.json relative to the installed location
    const sdkPath = import.meta.resolve('@openai/codex-sdk/package.json');
    const sdkUrl = sdkPath.startsWith('file://') ? new URL(sdkPath).pathname : sdkPath;
    const raw = readFileSync(sdkUrl, 'utf-8');
    const sdkPkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const codexDep = sdkPkg.dependencies?.['@openai/codex'];
    if (codexDep) return codexDep;
  } catch {
    // Fall through
  }
  throw new Error('Could not determine @openai/codex-sdk version for binary download');
}

const execFileAsync = promisify(execFile);

/**
 * Download the platform-specific Codex binary from npm registry.
 * Uses atomic download (temp dir + rename) to prevent partial installs.
 */
async function downloadCodexBinary(vendorDir: string, platformInfo: PlatformInfo): Promise<string> {
  const version = getCodexSdkVersion();
  const tarballUrl = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platformInfo.npmTag}.tgz`;
  const binaryPath = join(vendorDir, platformInfo.binarySubpath);
  const tempDir = join(vendorDir, `.download-${Date.now()}`);

  getLog().info({ tarballUrl, vendorDir }, 'codex.binary_download_started');

  try {
    await mkdir(tempDir, { recursive: true });

    // Download tarball
    const response = await fetch(tarballUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download Codex binary: HTTP ${response.status} from ${tarballUrl}\n\n` +
          'If you have Codex CLI installed separately, set CODEX_BIN_PATH to its location,\n' +
          'or set assistants.codex.codexBinaryPath in .archon/config.yaml.'
      );
    }

    const tarballPath = join(tempDir, 'codex.tgz');
    const buffer = await response.arrayBuffer();
    await writeFile(tarballPath, Buffer.from(buffer));

    // Extract using system tar (available on macOS and Linux)
    await execFileAsync('tar', ['xzf', tarballPath, '-C', tempDir, '--strip-components=1']);

    // Move extracted vendor dir to final location
    const extractedVendor = join(tempDir, 'vendor');
    const targetDir = dirname(binaryPath);
    await mkdir(dirname(targetDir), { recursive: true });

    // If target already exists (race condition), remove it first
    if (fileExists(targetDir)) {
      await rm(targetDir, { recursive: true });
    }
    await rename(join(extractedVendor, platformInfo.triple), targetDir);

    await chmod(binaryPath, 0o755);

    getLog().info({ binaryPath, version }, 'codex.binary_download_completed');
    return binaryPath;
  } finally {
    // Clean up temp dir
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Resolve the path to the Codex native binary.
 *
 * In dev mode: returns undefined (let SDK resolve via node_modules).
 * In binary mode: resolves from env/config/vendor dir, downloads if needed.
 */
export async function resolveCodexBinaryPath(
  configCodexBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  const platformKey = getPlatformKey();
  const platformInfo = PLATFORM_MAP[platformKey];
  if (!platformInfo) {
    throw new Error(
      `Unsupported platform for Codex: ${process.platform} (${process.arch})\n\n` +
        'Codex CLI binaries are only available for darwin-arm64, darwin-x64, linux-arm64, and linux-x64.'
    );
  }

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

  // 3. Check vendor directory
  const archonHome = getArchonHome();
  const vendorDir = join(archonHome, CODEX_VENDOR_DIR);
  const vendorBinaryPath = join(vendorDir, platformInfo.binarySubpath);

  if (fileExists(vendorBinaryPath)) {
    getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'codex.binary_resolved');
    return vendorBinaryPath;
  }

  // 4. Auto-download
  getLog().info({ platformKey, vendorDir }, 'codex.binary_not_found_downloading');
  return downloadCodexBinary(vendorDir, platformInfo);
}
