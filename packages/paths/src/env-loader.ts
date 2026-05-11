/**
 * Archon-owned env loader — runs at every entry point AFTER stripCwdEnv().
 *
 * Loads env vars from two archon-owned locations and emits operator-facing log
 * lines naming the exact paths and key counts. Replaces the misleading
 * `[dotenv@17.3.1] injecting env (N) from .env` preamble (see #1302).
 *
 * Load order (later sources win because `override: true`):
 *   1. ~/.archon/.env         — user-scope defaults, apply everywhere
 *   2. <cwd>/.archon/.env     — repo-scope overrides for this project
 *
 * `<cwd>/.env` is intentionally NOT loaded — it belongs to the user's target
 * repo and is stripped by stripCwdEnv() (see #1302 / #1303 three-path model).
 * Directory ownership (`.archon/`) is the security boundary, not the filename.
 *
 * Logging rules:
 *   - Each `[archon] loaded N keys from …` line prints only when N > 0.
 *   - Silent in the common case (no archon-owned env files present).
 *   - Emits to stderr (operator signal) — Pino logger is not yet initialized
 *     at this point in boot.
 *   - Passes `{ quiet: true }` to suppress dotenv's own `[dotenv@17.3.1] …`
 *     output.
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { getArchonEnvPath, getRepoArchonEnvPath } from './archon-paths';

/**
 * Shorten a path with `~` when it lives under the current user's home directory.
 * Used only for log rendering — never for filesystem operations.
 */
function displayPath(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/**
 * Load archon-owned env files. Call once, immediately after
 * `@archon/paths/strip-cwd-env-boot` at each entry point.
 *
 * Both loads use `override: true` so:
 *   - `~/.archon/.env` wins over shell-inherited vars (archon intent wins).
 *   - `<cwd>/.archon/.env` wins over `~/.archon/.env` (repo scope wins).
 *
 * A malformed env file is fatal — matches the pre-existing CLI behavior at
 * packages/cli/src/cli.ts:24-30.
 */
export function loadArchonEnv(cwd: string = process.cwd()): void {
  const homePath = getArchonEnvPath();
  if (existsSync(homePath)) {
    const result = config({ path: homePath, override: true, quiet: true });
    if (result.error) {
      console.error(`Error loading .env from ${homePath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    const count = Object.keys(result.parsed ?? {}).length;
    if (count > 0) {
      process.stderr.write(`[archon] loaded ${count} keys from ${displayPath(homePath)}\n`);
    }
  }

  const repoPath = getRepoArchonEnvPath(cwd);
  if (existsSync(repoPath)) {
    const result = config({ path: repoPath, override: true, quiet: true });
    if (result.error) {
      console.error(`Error loading .env from ${repoPath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    const count = Object.keys(result.parsed ?? {}).length;
    if (count > 0) {
      process.stderr.write(
        `[archon] loaded ${count} keys from ${displayPath(repoPath)} (repo scope, overrides user scope)\n`
      );
    }
  }
}
