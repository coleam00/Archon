import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { loadArchonEnv } from './env-loader';

/**
 * loadArchonEnv covers the read side of the three-path env model (#1302):
 *   ~/.archon/.env         → home scope, override: true
 *   <cwd>/.archon/.env     → repo scope, override: true (wins over home)
 *
 * Tests drive the home scope via ARCHON_HOME and the repo scope via the `cwd`
 * argument. Both are tmpdirs; no real ~/.archon/ is touched.
 */

const tmpRoot = join(import.meta.dir, '__env-loader-test-tmp__');
const archonHomeDir = join(tmpRoot, 'archon-home');
const repoDir = join(tmpRoot, 'repo');

// Keys we set/clear in tests. Using namespaced names to avoid collisions with
// anything a developer might have in their real shell env.
const TEST_KEYS = ['TEST_EL_HOME_ONLY', 'TEST_EL_REPO_ONLY', 'TEST_EL_OVERLAP', 'TEST_EL_OTHER'];

let originalArchonHome: string | undefined;
let originalArchonVerboseBoot: string | undefined;
let originalLogLevel: string | undefined;
let stderrSpy: ReturnType<typeof spyOn>;
let stderrWrites: string[];

beforeEach(() => {
  mkdirSync(archonHomeDir, { recursive: true });
  mkdirSync(join(repoDir, '.archon'), { recursive: true });

  originalArchonHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = archonHomeDir;

  // Clear verbose-boot toggles so each test starts suppressed and can opt in explicitly.
  originalArchonVerboseBoot = process.env.ARCHON_VERBOSE_BOOT;
  originalLogLevel = process.env.LOG_LEVEL;
  delete process.env.ARCHON_VERBOSE_BOOT;
  delete process.env.LOG_LEVEL;

  for (const k of TEST_KEYS) delete process.env[k];

  stderrWrites = [];
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });

  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;

  if (originalArchonVerboseBoot === undefined) delete process.env.ARCHON_VERBOSE_BOOT;
  else process.env.ARCHON_VERBOSE_BOOT = originalArchonVerboseBoot;

  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;

  for (const k of TEST_KEYS) delete process.env[k];
});

describe('loadArchonEnv', () => {
  it('loads keys from ~/.archon/.env and emits a [archon] loaded line when verbose-boot is set', () => {
    process.env.ARCHON_VERBOSE_BOOT = '1';
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\nTEST_EL_OTHER=keep\n');

    loadArchonEnv(repoDir);

    expect(process.env.TEST_EL_HOME_ONLY).toBe('from-home');
    expect(process.env.TEST_EL_OTHER).toBe('keep');
    // Tilde-shortening of the rendered path is opportunistic (only when the
    // tmpdir lives under `homedir()`). On Windows CI the tmpdir is on a
    // different drive and the path renders absolute, so we match on count and
    // the archon-home tmpdir segment rather than a literal `~` prefix.
    const line = stderrWrites.find(s => s.includes('[archon] loaded') && !s.includes('repo scope'));
    expect(line).toBeDefined();
    expect(line).toContain('loaded 2 keys');
    expect(line).toContain(join('archon-home', '.env'));
  });

  it('loads keys from <cwd>/.archon/.env and marks it as repo scope when verbose-boot is set', () => {
    process.env.ARCHON_VERBOSE_BOOT = '1';
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_REPO_ONLY=from-repo\n');

    loadArchonEnv(repoDir);

    expect(process.env.TEST_EL_REPO_ONLY).toBe('from-repo');
    const line = stderrWrites.find(s => s.includes('repo scope, overrides user scope'));
    expect(line).toBeDefined();
    expect(line).toContain('loaded 1 keys');
    // Path rendering tildes anything under the user's home directory — assert
    // on the suffix (the `.archon/.env` segment) rather than the full path,
    // because the tmpdir may or may not live under $HOME on CI.
    expect(line).toContain(join('.archon', '.env'));
  });

  it('does not emit loaded lines by default even when keys are present', () => {
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_REPO_ONLY=from-repo\n');

    loadArchonEnv(repoDir);

    // Keys are still loaded into process.env — only the stderr line is gated.
    expect(process.env.TEST_EL_HOME_ONLY).toBe('from-home');
    expect(process.env.TEST_EL_REPO_ONLY).toBe('from-repo');
    const anyLoaded = stderrWrites.find(s => s.includes('[archon] loaded'));
    expect(anyLoaded).toBeUndefined();
  });

  it('emits loaded lines when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');

    loadArchonEnv(repoDir);

    const line = stderrWrites.find(s => s.includes('[archon] loaded') && !s.includes('repo scope'));
    expect(line).toBeDefined();
  });

  it('repo scope overrides home scope on overlapping keys', () => {
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_OVERLAP=from-home\n');
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_OVERLAP=from-repo\n');

    loadArchonEnv(repoDir);

    expect(process.env.TEST_EL_OVERLAP).toBe('from-repo');
  });

  it('emits nothing when neither file exists', () => {
    loadArchonEnv(repoDir);
    const anyLoaded = stderrWrites.find(s => s.includes('[archon] loaded'));
    expect(anyLoaded).toBeUndefined();
  });

  it('emits no loaded line when a file exists but is empty', () => {
    writeFileSync(join(archonHomeDir, '.env'), '');
    writeFileSync(join(repoDir, '.archon', '.env'), '');

    loadArchonEnv(repoDir);

    const anyLoaded = stderrWrites.find(s => s.includes('[archon] loaded'));
    expect(anyLoaded).toBeUndefined();
  });

  it('exits with error when env file has a dotenv-unparseable layout', () => {
    // dotenv.parse is very permissive — lines without `=` are silently ignored,
    // so syntactic errors that actually surface are rare. We instead simulate
    // a permission-style failure by writing a path that cannot be read: pass a
    // directory in place of a file. dotenv.config returns an error for EISDIR.
    // (Use the home slot since the repo path derives from cwd inside the fn.)
    rmSync(join(archonHomeDir, '.env'), { force: true });
    mkdirSync(join(archonHomeDir, '.env'), { recursive: true }); // directory at .env path

    const consoleErrorMessages: string[] = [];
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
      consoleErrorMessages.push(String(msg));
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      expect(() => loadArchonEnv(repoDir)).toThrow('process.exit called');
      const msg = consoleErrorMessages.find(s => s.startsWith('Error loading .env'));
      expect(msg).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('emits loaded lines when LOG_LEVEL=trace', () => {
    process.env.LOG_LEVEL = 'trace';
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');

    loadArchonEnv(repoDir);

    const line = stderrWrites.find(s => s.includes('[archon] loaded') && !s.includes('repo scope'));
    expect(line).toBeDefined();
  });

  it('does not emit loaded lines when ARCHON_VERBOSE_BOOT is set to a non-"1" value', () => {
    process.env.ARCHON_VERBOSE_BOOT = 'true';
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');

    loadArchonEnv(repoDir);

    const anyLoaded = stderrWrites.find(s => s.includes('[archon] loaded'));
    expect(anyLoaded).toBeUndefined();
  });
});
