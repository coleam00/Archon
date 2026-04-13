/**
 * Cleans process.env at startup — BEFORE any module reads env at init time
 * (notably `@archon/paths/logger` which reads `LOG_LEVEL` during module load).
 *
 * Two concerns handled in one pass:
 *
 * 1. CWD .env leak: Bun unconditionally loads .env / .env.local /
 *    .env.development / .env.production from CWD before any user code runs.
 *    When `archon` is invoked from inside a target repo, that repo's env vars
 *    leak into the Archon process. `override: true` in dotenv only fixes keys
 *    that exist in both files — keys that only appear in the target repo's .env
 *    survive unaffected. We strip them.
 *
 * 2. Nested Claude Code session markers: When archon is launched from inside a
 *    Claude Code terminal, the parent shell exports CLAUDECODE=1 and several
 *    CLAUDE_CODE_* markers. The Claude Agent SDK leaks process.env into the
 *    spawned child regardless of the explicit `env` option
 *    (see coleam00/Archon#1097), so the only way to prevent the nested-session
 *    deadlock is to delete the markers from process.env at the entry point.
 *    Auth vars (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK,
 *    CLAUDE_CODE_USE_VERTEX) are kept.
 */
import { config } from 'dotenv';
import { resolve } from 'path';

/** The four filenames Bun auto-loads from CWD (in loading order). */
const BUN_AUTO_LOADED_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production'];

/** CLAUDE_CODE_* vars that are auth-related and must be kept in process.env. */
const CLAUDE_CODE_AUTH_VARS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);

/**
 * Strip CWD .env keys and nested Claude Code session markers from process.env.
 * Keys in ~/.archon/.env (loaded afterward by each entry point) are unaffected.
 * Safe to call even when no CWD .env files exist.
 */
export function stripCwdEnv(cwd: string = process.cwd()): void {
  // --- Pass 1: CWD .env files ---
  const cwdKeys = new Set<string>();

  for (const filename of BUN_AUTO_LOADED_ENV_FILES) {
    const filepath = resolve(cwd, filename);
    // dotenv.config with processEnv:{} parses without writing to process.env
    const result = config({ path: filepath, processEnv: {} });
    if (result.error) {
      // ENOENT is expected (file simply doesn't exist) — all others are unexpected
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        process.stderr.write(
          `[archon] Warning: could not parse ${filepath} for CWD env stripping: ${result.error.message}\n`
        );
      }
    } else if (result.parsed) {
      for (const key of Object.keys(result.parsed)) {
        cwdKeys.add(key);
      }
    }
  }

  for (const key of cwdKeys) {
    Reflect.deleteProperty(process.env, key);
  }

  // --- Pass 2: Nested Claude Code session markers ---
  // Pattern-matched (not hardcoded) so new CLAUDE_CODE_* markers added by
  // future Claude Code versions are automatically handled.
  // Emit warning BEFORE deleting — downstream code won't see CLAUDECODE=1.
  if (process.env.CLAUDECODE === '1' && !process.env.ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING) {
    process.stderr.write(
      '\u26a0  Detected CLAUDECODE=1 \u2014 running inside a Claude Code session.\n' +
        '   If workflows hang silently, this is a known class of issue.\n' +
        '   Workaround: run `archon serve` from a regular shell.\n' +
        '   Suppress: set ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING=1\n' +
        '   Details: https://github.com/coleam00/Archon/issues/1067\n'
    );
  }
  if (process.env.CLAUDECODE) {
    Reflect.deleteProperty(process.env, 'CLAUDECODE');
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CLAUDE_CODE_') && !CLAUDE_CODE_AUTH_VARS.has(key)) {
      Reflect.deleteProperty(process.env, key);
    }
  }

  // Strip debugger vars that crash Claude Code subprocesses
  // See: https://github.com/anthropics/claude-code/issues/4619
  Reflect.deleteProperty(process.env, 'NODE_OPTIONS');
  Reflect.deleteProperty(process.env, 'VSCODE_INSPECTOR_OPTIONS');
}
