/**
 * Claude Code CLI resolver for compiled (bun --compile) archon binaries.
 *
 * The @anthropic-ai/claude-agent-sdk spawns a subprocess using
 * `pathToClaudeCodeExecutable`. In dev mode the SDK resolves this from its
 * own node_modules location; in compiled binaries that path is frozen to
 * the build host's filesystem and does not exist on end-user machines.
 *
 * Resolution order (binary mode only):
 * 1. `CLAUDE_BIN_PATH` environment variable
 * 2. `assistants.claude.claudeBinaryPath` in config
 * 3. Throw with install instructions
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the caller
 * omits `pathToClaudeCodeExecutable` entirely and the SDK resolves via its
 * normal node_modules lookup.
 */
import { existsSync as _existsSync } from 'node:fs';
import { BUNDLED_IS_BINARY, createLogger } from '@harneeslab/paths';

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
  'See: https://harneeslab.codewithgenie.com/reference/configuration/#claude';

/**
 * Resolve the path to the Claude Code SDK's cli.js.
 *
 * In dev mode: returns undefined (let SDK resolve via node_modules).
 * In binary mode: resolves from env/config, or throws with install instructions.
 */
export async function resolveClaudeBinaryPath(
  configClaudeBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

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

  // 3. Not found — throw with install instructions
  throw new Error(INSTALL_INSTRUCTIONS);
}
