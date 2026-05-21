/**
 * Claude Code CLI resolver for compiled (bun --compile) archon binaries.
 *
 * The @anthropic-ai/claude-agent-sdk spawns a subprocess using
 * `pathToClaudeCodeExecutable`. In dev mode the SDK resolves this from its
 * own node_modules location; in compiled binaries that path is frozen to
 * the build host's filesystem and does not exist on end-user machines.
 *
 * Resolution order:
 * 1. `CLAUDE_BIN_PATH` environment variable (honored in both modes — escape
 *    hatch for hosts where the SDK's per-platform binary auto-resolution
 *    picks the wrong variant, e.g. glibc Linux + musl SDK package)
 * 2. `assistants.claude.claudeBinaryPath` in config (binary mode only)
 * 3. Autodetect canonical install path (binary mode only — native installer default)
 * 4. Throw with install instructions (binary mode only)
 *
 * In dev mode (BUNDLED_IS_BINARY=false), if no env var is set, returns
 * undefined so the caller omits `pathToClaudeCodeExecutable` entirely and
 * the SDK resolves via its normal node_modules lookup.
 */
import { existsSync as _existsSync, statSync as _statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/**
 * Classify a configured path. The Claude Agent SDK requires a spawnable file:
 * a directory passes `existsSync` but fails downstream as ENOENT inside the
 * SDK's `child_process.spawn`, surfaced as the misleading "native binary not
 * found" error. Wrapped for spyOn parity with `fileExists`.
 *
 * Non-file, non-directory entries (sockets, FIFOs, etc.) are reported as
 * 'missing' so the caller's "set to X but unusable" error path fires.
 */
export function pathKind(path: string): 'file' | 'directory' | 'missing' {
  try {
    const stat = _statSync(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'missing';
  } catch {
    return 'missing';
  }
}

/**
 * If a configured path is a directory, expand to the platform-appropriate
 * child executable (`claude.exe` on Windows, `claude` on Unix). Common when
 * users point at the npm platform-package directory
 * (`@anthropic-ai/claude-code-<platform>`), which contains the binary inside.
 * Returns the expanded file path if present, otherwise undefined.
 */
function expandDirectoryToExecutable(dir: string): string | undefined {
  const candidate = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return pathKind(candidate) === 'file' ? candidate : undefined;
}

/**
 * Validate a user-supplied path and, if a directory is given, expand to the
 * platform-appropriate child executable. Distinguishes missing paths from
 * directories-without-the-expected-binary so the error message tells the user
 * what to fix.
 */
function validateAndExpand(rawPath: string, sourceLabel: string): string {
  const kind = pathKind(rawPath);
  if (kind === 'file') return rawPath;
  if (kind === 'directory') {
    const expanded = expandDirectoryToExecutable(rawPath);
    if (expanded) return expanded;
    const expected = process.platform === 'win32' ? 'claude.exe' : 'claude';
    throw new Error(
      `${sourceLabel} is set to "${rawPath}", which is a directory, but it does not contain ${expected}.\n` +
        'Please point this setting at the Claude Code executable itself (native binary\n' +
        'from the curl/PowerShell installer, or cli.js from an npm global install).'
    );
  }
  throw new Error(
    `${sourceLabel} is set to "${rawPath}" but the file does not exist.\n` +
      'Please verify the path points to the Claude Code executable (native binary\n' +
      'from the curl/PowerShell installer, or cli.js from an npm global install).'
  );
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('claude-binary');
  return cachedLog;
}

const INSTALL_INSTRUCTIONS =
  'Claude Code not found. Archon requires the Claude Code executable to be\n' +
  'reachable at a configured path in compiled builds.\n\n' +
  'To fix, install Claude Code and point Archon at it:\n\n' +
  '  macOS / Linux (recommended — native installer):\n' +
  '    curl -fsSL https://claude.ai/install.sh | bash\n' +
  '    export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"\n\n' +
  '  Windows (PowerShell):\n' +
  '    irm https://claude.ai/install.ps1 | iex\n' +
  '    $env:CLAUDE_BIN_PATH = "$env:USERPROFILE\\.local\\bin\\claude.exe"\n\n' +
  '  Or via npm (alternative):\n' +
  '    npm install -g @anthropic-ai/claude-code\n' +
  '    export CLAUDE_BIN_PATH="$(npm root -g)/@anthropic-ai/claude-code/cli.js"\n\n' +
  'Persist the path in ~/.archon/config.yaml instead of the env var:\n' +
  '    assistants:\n' +
  '      claude:\n' +
  '        claudeBinaryPath: /absolute/path/to/claude\n\n' +
  'See: https://archon.diy/docs/reference/configuration#claude';

/**
 * Resolve the path to the Claude Code executable (native binary in SDK 0.2.x;
 * legacy `cli.js` is still accepted for operators pinned to npm-installed
 * SDKs that ship a JS entry point).
 *
 * In dev mode: honors `CLAUDE_BIN_PATH` if set; otherwise returns undefined
 * (let SDK resolve from its bundled per-platform native binary in
 * `@anthropic-ai/claude-agent-sdk-<platform>`).
 * In binary mode: resolves from env/config/autodetect, or throws with
 * install instructions.
 */
export async function resolveClaudeBinaryPath(
  configClaudeBinaryPath?: string
): Promise<string | undefined> {
  // 1. Environment variable override — honored in dev mode too, so operators
  // on libc mismatches (e.g. glibc host with the SDK's musl variant first in
  // its resolution order) can pin a known-good binary without a compiled build.
  const envPath = process.env.CLAUDE_BIN_PATH;
  if (envPath) {
    const resolvedEnv = validateAndExpand(envPath, 'CLAUDE_BIN_PATH');
    getLog().info({ binaryPath: resolvedEnv, source: 'env' }, 'claude.binary_resolved');
    return resolvedEnv;
  }

  if (!BUNDLED_IS_BINARY) return undefined;

  // 2. Config file override
  if (configClaudeBinaryPath) {
    const resolvedConfig = validateAndExpand(
      configClaudeBinaryPath,
      'assistants.claude.claudeBinaryPath'
    );
    getLog().info({ binaryPath: resolvedConfig, source: 'config' }, 'claude.binary_resolved');
    return resolvedConfig;
  }

  // 3. Autodetect — the Anthropic native installer
  // (`curl -fsSL https://claude.ai/install.sh | bash` on macOS/Linux,
  // `irm https://claude.ai/install.ps1 | iex` on Windows) writes the
  // executable to a fixed location relative to $HOME. Users who follow
  // the recommended install path don't need any env var or config entry;
  // users who deviate (npm global, custom path, etc.) still set one of
  // the higher-priority sources above.
  const nativeInstallerPath =
    process.platform === 'win32'
      ? join(homedir(), '.local', 'bin', 'claude.exe')
      : join(homedir(), '.local', 'bin', 'claude');
  if (fileExists(nativeInstallerPath)) {
    getLog().info(
      { binaryPath: nativeInstallerPath, source: 'autodetect' },
      'claude.binary_resolved'
    );
    return nativeInstallerPath;
  }

  // 4. Not found — throw with install instructions
  throw new Error(INSTALL_INSTRUCTIONS);
}
