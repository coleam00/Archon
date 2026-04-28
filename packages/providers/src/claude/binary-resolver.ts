/**
 * Claude Code CLI resolver for compiled (bun --compile) archon binaries.
 *
 * The @anthropic-ai/claude-agent-sdk spawns a subprocess using
 * `pathToClaudeCodeExecutable`. In dev mode the SDK resolves this from its
 * own node_modules location; in compiled binaries that path is frozen to
 * the build host's filesystem and does not exist on end-user machines.
 *
 * Resolution order (applies in both dev and binary mode — see note below):
 * 1. `CLAUDE_BIN_PATH` environment variable
 * 2. `assistants.claude.claudeBinaryPath` in config
 * 3. Autodetect canonical install path (native installer default)
 * 4. Throw with install instructions
 *
 * Dev mode used to short-circuit at step 0 (return undefined so the SDK
 * resolved via its own node_modules lookup). claude-agent-sdk 0.2.121
 * dropped the bundled `cli.js` in favor of a native platform binary, and
 * `shouldPassNoEnvFile` then incorrectly forwarded `--no-env-file` to that
 * native binary (which rejects it). Honoring env/config/autodetect in dev
 * mode too returns a real path so the JS-vs-binary detection downstream
 * can see what's actually being spawned.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
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
 * Resolve the path to the Claude Code executable.
 *
 * Returns env override, config override, autodetected native install, or
 * throws install instructions. Same chain in dev and binary mode.
 */
export async function resolveClaudeBinaryPath(
  configClaudeBinaryPath?: string
): Promise<string | undefined> {
  // 1. Environment variable override
  const envPath = process.env.CLAUDE_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `CLAUDE_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the Claude Code executable (native binary\n' +
          'from the curl/PowerShell installer, or cli.js from an npm global install).'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'claude.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configClaudeBinaryPath) {
    if (!fileExists(configClaudeBinaryPath)) {
      throw new Error(
        `assistants.claude.claudeBinaryPath is set to "${configClaudeBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the Claude Code executable.'
      );
    }
    getLog().info(
      { binaryPath: configClaudeBinaryPath, source: 'config' },
      'claude.binary_resolved'
    );
    return configClaudeBinaryPath;
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
