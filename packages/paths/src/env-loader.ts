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
 *   - The `[archon] stripped N keys from <cwd> …` line (what stripCwdEnv() removed)
 *     prints the first time a project's set of stripped files and key names is
 *     seen, and again when it changes. A fingerprint per project is kept in
 *     `<ARCHON_HOME>/cwd-env-notice.json`. Verbose boot prints it every time, and
 *     a `cwd_env.stripped` debug log event records it on every boot. It is
 *     reported here, not in stripCwdEnv(), because only after the user-scope load
 *     are ARCHON_HOME and the verbosity switches final. A repo-scope
 *     `.archon/.env` loads after it and does not change its verbosity.
 *   - Each `[archon] loaded N keys from …` line prints only when N > 0 AND
 *     the operator has opted into verbose boot output via `ARCHON_VERBOSE_BOOT=1`
 *     or `LOG_LEVEL=debug`/`trace`. Silent by default — these run before
 *     parseArgs() so they would otherwise leak into interactive command output.
 *   - Silent in the common case (no archon-owned env files present).
 *   - Emits to stderr (operator signal) — Pino logger is not yet initialized
 *     at this point in boot.
 *   - Passes `{ quiet: true }` to suppress dotenv's own `[dotenv@17.3.1] …`
 *     output.
 */
import { createHash } from 'crypto';
import { config, parse } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getArchonEnvPath, getArchonHome, getRepoArchonEnvPath } from './home-paths';
import { applyEnvLogLevel, createLogger } from './logger';
import { takeCwdEnvStrip } from './strip-cwd-env';

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

// Verbosity is signaled via env vars because this runs before parseArgs() and Pino.
export function isVerboseBoot(): boolean {
  if (process.env.ARCHON_VERBOSE_BOOT === '1') return true;
  const level = process.env.LOG_LEVEL?.toLowerCase();
  return level === 'debug' || level === 'trace';
}

/**
 * `<ARCHON_HOME>/plugins`: where every plugin kind installs, and where forge discovery
 * and workflow-pack discovery read them. A repository's `.archon/.env` cannot move
 * ARCHON_HOME (see {@link REPO_SCOPE_REFUSED_KEYS}), so install and every reader agree.
 */
export function getPluginsPath(archonHome: string = getArchonHome()): string {
  return join(archonHome, 'plugins');
}

/**
 * Keys a repository's `.archon/.env` may not set. Each can move the Archon home or the
 * executables Archon runs, so letting the repo scope set them would let a repository
 * choose which plugins run: ARCHON_HOME directly, HOME and USERPROFILE (Windows)
 * through the default `~/.archon`, ARCHON_DOCKER and WORKSPACE_PATH through the
 * Docker home `/.archon` (see `isDocker`), and PATH through executable lookup. A
 * deployment sets the Docker markers in its image or process environment. The process
 * environment and the user-scope `~/.archon/.env` may still set all of them.
 */
const REPO_SCOPE_REFUSED_KEYS = [
  'ARCHON_HOME',
  'HOME',
  'USERPROFILE',
  'ARCHON_DOCKER',
  'WORKSPACE_PATH',
  'PATH',
];

/**
 * Load archon-owned env files. Call once, immediately after
 * `@archon/paths/strip-cwd-env-boot` at each entry point.
 *
 * Both loads use `override: true` so:
 *   - `~/.archon/.env` wins over shell-inherited vars (archon intent wins).
 *   - `<cwd>/.archon/.env` wins over `~/.archon/.env` (repo scope wins).
 *
 * A repo-scope file that sets any of {@link REPO_SCOPE_REFUSED_KEYS} is refused before
 * any of its keys apply.
 *
 * A malformed env file is fatal — matches the pre-existing CLI behavior at
 * packages/cli/src/cli.ts:24-30.
 */
export function loadArchonEnv(
  cwd: string = process.cwd(),
  options: { afterUserLoad?: () => void; env?: NodeJS.ProcessEnv } = {}
): void {
  const env = options.env ?? process.env;
  const logLevelBefore = process.env.LOG_LEVEL;
  const homePath = getArchonEnvPath(env);
  if (existsSync(homePath)) {
    const result = config({ path: homePath, processEnv: env, override: true, quiet: true });
    if (result.error) {
      console.error(`Error loading .env from ${homePath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    const count = Object.keys(result.parsed ?? {}).length;
    if (count > 0 && isVerboseBoot()) {
      process.stderr.write(`[archon] loaded ${count} keys from ${displayPath(homePath)}\n`);
    }
  }

  options.afterUserLoad?.();

  // The logger fixed its level before these files loaded; hand it a LOG_LEVEL they set.
  if (process.env.LOG_LEVEL !== logLevelBefore) applyEnvLogLevel();
  // Before the repo scope, which can refuse startup: the strip is reported or logged
  // even then. ARCHON_HOME is already final, because the repo scope cannot set it.
  reportCwdEnvStrip(env);

  const logLevelBeforeRepo = process.env.LOG_LEVEL;
  loadRepoEnv(cwd, homePath, env);
  if (process.env.LOG_LEVEL !== logLevelBeforeRepo) applyEnvLogLevel();
}

const CWD_ENV_NOTICE_FILE = 'cwd-env-notice.json';

/**
 * Report what stripCwdEnv() removed. A debug log event records it on every boot. The
 * operator line prints once per project and again when the stripped files or key names
 * change, including after a boot that stripped nothing. The state file holds a hash per
 * project, not the key names. A missing or corrupt state file means "not shown yet", so
 * the line prints; a failed write only means it prints again next time.
 */
function reportCwdEnvStrip(env: NodeJS.ProcessEnv): void {
  const strip = takeCwdEnvStrip();
  if (!strip) return;
  // Created here, not at module load: a child logger keeps the level it was created with.
  const log = createLogger('env-loader');
  if (strip.keys.length > 0) {
    log.debug({ cwd: strip.cwd, files: strip.files, keys: strip.keys }, 'cwd_env.stripped');
  }

  const archonHome = getArchonHome(env);
  const statePath = join(archonHome, CWD_ENV_NOTICE_FILE);
  const projects = readCwdEnvNoticeProjects(statePath, log);
  const { [strip.cwd]: shown, ...otherProjects } = projects;
  const fingerprint =
    strip.keys.length > 0
      ? createHash('sha256')
          .update(JSON.stringify([strip.files, strip.keys]))
          .digest('hex')
      : undefined;
  const changed = shown !== fingerprint;

  if (fingerprint && (changed || isVerboseBoot())) {
    const count = strip.keys.length;
    process.stderr.write(
      `[archon] stripped ${count} ${count === 1 ? 'key' : 'keys'} from ${strip.cwd} (${strip.files.join(', ')}). ` +
        "Archon does not load a target repository's .env files into its own processes, so a " +
        'key there cannot override Archon settings or credentials (an ANTHROPIC_API_KEY ' +
        'would bill the API instead of your Claude subscription).\n'
    );
  }
  if (!changed) return;

  try {
    mkdirSync(archonHome, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        projects: fingerprint ? { ...otherProjects, [strip.cwd]: fingerprint } : otherProjects,
      }),
      'utf-8'
    );
  } catch (err) {
    log.debug({ err }, 'cwd_env_notice.write_failed');
  }
}

function readCwdEnvNoticeProjects(
  statePath: string,
  log: ReturnType<typeof createLogger>
): Record<string, string> {
  if (!existsSync(statePath)) return {};
  try {
    const data = JSON.parse(readFileSync(statePath, 'utf-8')) as { projects?: unknown };
    if (data.projects && typeof data.projects === 'object') {
      return data.projects as Record<string, string>;
    }
  } catch (err) {
    // Unreadable: the notice counts as not shown.
    log.debug({ err }, 'cwd_env_notice.read_failed');
  }
  return {};
}

function loadRepoEnv(cwd: string, homePath: string, env: NodeJS.ProcessEnv): void {
  const repoPath = getRepoArchonEnvPath(cwd);
  if (existsSync(repoPath)) {
    // Parse without applying, so a refused file changes nothing.
    const result = config({ path: repoPath, processEnv: {}, quiet: true });
    if (result.error) {
      console.error(`Error loading .env from ${repoPath}: ${result.error.message}`);
      console.error('Hint: Check for syntax errors in your .env file.');
      process.exit(1);
    }
    const parsed = result.parsed ?? {};
    // Windows env names are case-insensitive, so `Path=` there is PATH.
    const refused = Object.keys(parsed).filter(key =>
      REPO_SCOPE_REFUSED_KEYS.includes(process.platform === 'win32' ? key.toUpperCase() : key)
    );
    if (refused.length > 0) {
      console.error(
        `${repoPath} sets ${refused.join(', ')}. A repository's .archon/.env cannot set ` +
          `${REPO_SCOPE_REFUSED_KEYS.join(', ')}; set them in the environment or in ` +
          `${displayPath(homePath)} instead.`
      );
      process.exit(1);
    }
    Object.assign(env, parsed);
    const count = Object.keys(parsed).length;
    if (count > 0 && isVerboseBoot()) {
      process.stderr.write(
        `[archon] loaded ${count} keys from ${displayPath(repoPath)} (repo scope, overrides user scope)\n`
      );
    }
  }
}

function envFileKeyNames(path: string): string[] {
  return existsSync(path) ? Object.keys(parse(readFileSync(path))) : [];
}

/**
 * Names `~/.archon/.env`/`<cwd>/.archon/.env` declare, read fresh from disk rather than
 * from `loadArchonEnv`'s own already-applied result.
 *
 * This is the "Archon supplies this" set the exec env-read checker (see
 * `@archon/workflows`' `exec-input-validation.ts`) treats as configured — deliberately
 * not the process's full ambient environment. `loadArchonEnv` folds both files into
 * `process.env`, which also holds every shell/CI var inherited at process start; a
 * checker that trusted all of `process.env` would stop warning on a genuinely unbound
 * name the moment it happened to collide with one of those, not with anything Archon
 * actually supplies.
 */
export function getArchonEnvNames(cwd: string = process.cwd()): ReadonlySet<string> {
  return new Set([
    ...envFileKeyNames(getArchonEnvPath()),
    ...envFileKeyNames(getRepoArchonEnvPath(cwd)),
  ]);
}
