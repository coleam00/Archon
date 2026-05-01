/**
 * GitHub Copilot CLI community provider — binary resolver.
 *
 * Resolution order:
 *  1. COPILOT_BIN_PATH environment variable
 *  2. assistants.copilot.copilotBinaryPath in config
 *  3. Default command name: 'copilot' / 'copilot.cmd' (relies on PATH lookup by the OS)
 *
 * Unlike the Codex resolver, we do NOT check for file existence when a
 * PATH-based name (no path separators) is returned — the OS does the PATH
 * lookup at spawn time. We only do existence checks for absolute/relative
 * paths explicitly configured by the user.
 *
 * On Windows, Copilot CLI is commonly installed as an npm/VS Code shim
 * (`copilot.cmd`/`copilot.bat`) rather than a real `copilot.exe`. Bun's spawn
 * does not resolve PATHEXT for bare names, so the default must include `.cmd`.
 */
import { existsSync as _existsSync } from 'node:fs';
import { createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests. */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('copilot-binary');
  return cachedLog;
}

/**
 * Returns true when the given string looks like an absolute or relative path
 * rather than a bare command name. Bare command names (e.g. 'copilot',
 * 'copilot.exe') are resolved via PATH at spawn time — no file-existence
 * check needed. Explicit paths (starting with '/', './', '../', or a Windows
 * drive letter like 'C:\') must exist to be useful.
 */
function looksLikePath(s: string): boolean {
  return (
    s.startsWith('/') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('.\\') ||
    s.startsWith('..\\') ||
    /^[A-Za-z]:[/\\]/.test(s) ||
    s.includes('/') ||
    s.includes('\\')
  );
}

/**
 * Resolve the Copilot CLI binary path/name.
 *
 * Returns the binary string to pass to `spawn()`.
 * For PATH-based names, returns the name without existence check.
 * For absolute/relative paths from env/config, validates existence.
 */
export function resolveCopilotBinaryPath(configBinaryPath?: string): string {
  // 1. Environment variable override
  const envPath = process.env.COPILOT_BIN_PATH?.trim();
  if (process.env.COPILOT_BIN_PATH !== undefined) {
    if (!envPath) {
      throw new Error('COPILOT_BIN_PATH is set but empty.');
    }
    if (looksLikePath(envPath) && !fileExists(envPath)) {
      throw new Error(
        `COPILOT_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the GitHub Copilot CLI binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'copilot.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  const trimmedConfigBinaryPath = configBinaryPath?.trim();
  if (configBinaryPath !== undefined) {
    if (!trimmedConfigBinaryPath) {
      throw new Error('assistants.copilot.copilotBinaryPath must not be empty.');
    }
    if (looksLikePath(trimmedConfigBinaryPath) && !fileExists(trimmedConfigBinaryPath)) {
      throw new Error(
        `assistants.copilot.copilotBinaryPath is set to "${trimmedConfigBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the GitHub Copilot CLI binary.'
      );
    }
    getLog().info(
      { binaryPath: trimmedConfigBinaryPath, source: 'config' },
      'copilot.binary_resolved'
    );
    return trimmedConfigBinaryPath;
  }

  // 3. PATH default — rely on OS PATH lookup at spawn time
  const defaultName = process.platform === 'win32' ? 'copilot.cmd' : 'copilot';
  getLog().debug({ binaryPath: defaultName, source: 'path-default' }, 'copilot.binary_resolved');
  return defaultName;
}
