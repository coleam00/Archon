import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getArchonEnvNames, getPluginsPath, loadArchonEnv } from './env-loader';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { getLogLevel, resetLogLevelOverride, rootLogger, setLogLevel, setLogSink } from './logger';
import { stripCwdEnv } from './strip-cwd-env';

/**
 * loadArchonEnv covers the read side of the three-path env model (#1302):
 *   ~/.archon/.env         → home scope, override: true
 *   <cwd>/.archon/.env     → repo scope, override: true (wins over home)
 *
 * Tests drive the home scope via ARCHON_HOME and the repo scope via the `cwd`
 * argument. Both are tmpdirs; no real ~/.archon/ is touched.
 */

const tmpRoot = mkdtempSync(join(tmpdir(), 'archon-env-loader-test-'));
const archonHomeDir = join(tmpRoot, 'archon-home');
const repoDir = join(tmpRoot, 'repo');

// Keys we set/clear in tests. Using namespaced names to avoid collisions with
// anything a developer might have in their real shell env.
const TEST_KEYS = ['TEST_EL_HOME_ONLY', 'TEST_EL_REPO_ONLY', 'TEST_EL_OVERLAP', 'TEST_EL_OTHER'];

let originalArchonHome: string | undefined;
// The repo-scope refusal tests write these; a pre-fix loader would apply them.
const REDIRECT_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'ARCHON_DOCKER', 'WORKSPACE_PATH'] as const;
let originalRedirects: Partial<Record<(typeof REDIRECT_KEYS)[number], string>>;
let originalArchonVerboseBoot: string | undefined;
let originalLogLevel: string | undefined;
let stderrSpy: ReturnType<typeof spyOn>;
let stderrWrites: string[];

beforeEach(() => {
  mkdirSync(archonHomeDir, { recursive: true });
  mkdirSync(join(repoDir, '.archon'), { recursive: true });

  originalArchonHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = archonHomeDir;
  originalRedirects = {};
  for (const key of REDIRECT_KEYS) originalRedirects[key] = process.env[key];

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

/**
 * The home-scope `[archon] loaded` lines emitted so far. The repo-scope line
 * carries the `repo scope, overrides user scope` suffix and is excluded here.
 *
 * Assertions go through the count and the line's content. `find(...)` plus a
 * bare `toBeDefined()` proved only that some line matched, never which one or
 * what it said (#3167).
 */
function homeScopeLoadedLines(): string[] {
  return stderrWrites.filter(s => s.startsWith('[archon] loaded') && !s.includes('repo scope'));
}

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });

  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  for (const key of REDIRECT_KEYS) {
    const value = originalRedirects[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

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
    const loaded = homeScopeLoadedLines();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toContain('loaded 2 keys');
    expect(loaded[0]).toContain(join('archon-home', '.env'));
  });

  it('loads keys from <cwd>/.archon/.env and marks it as repo scope when verbose-boot is set', () => {
    process.env.ARCHON_VERBOSE_BOOT = '1';
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_REPO_ONLY=from-repo\n');

    loadArchonEnv(repoDir);

    expect(process.env.TEST_EL_REPO_ONLY).toBe('from-repo');
    const repoScope = stderrWrites.filter(s => s.includes('repo scope, overrides user scope'));
    expect(repoScope).toHaveLength(1);
    expect(repoScope[0]).toContain('loaded 1 keys');
    // Path rendering tildes anything under the user's home directory — assert
    // on the suffix (the `.archon/.env` segment) rather than the full path,
    // because the tmpdir may or may not live under $HOME on CI.
    expect(repoScope[0]).toContain(join('.archon', '.env'));
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

    const loaded = homeScopeLoadedLines();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toContain('loaded 1 keys');
    expect(loaded[0]).toContain(join('archon-home', '.env'));
  });

  it('repo scope overrides home scope on overlapping keys', () => {
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_OVERLAP=from-home\n');
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_OVERLAP=from-repo\n');

    loadArchonEnv(repoDir);

    expect(process.env.TEST_EL_OVERLAP).toBe('from-repo');
  });

  it('can capture user scope before repo overrides are loaded', () => {
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_OVERLAP=from-home\n');
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_OVERLAP=from-repo\n');
    let userValue: string | undefined;

    loadArchonEnv(repoDir, {
      afterUserLoad: () => {
        userValue = process.env.TEST_EL_OVERLAP;
      },
    });

    expect(userValue).toBe('from-home');
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

  for (const key of [
    'ARCHON_HOME',
    'PATH',
    'HOME',
    'USERPROFILE',
    'ARCHON_DOCKER',
    'WORKSPACE_PATH',
  ]) {
    it(`refuses a repo .archon/.env that sets ${key}, naming the file and the key`, () => {
      const repoEnv = join(repoDir, '.archon', '.env');
      writeFileSync(repoEnv, `TEST_EL_REPO_ONLY=from-repo\n${key}=${join(tmpRoot, 'elsewhere')}\n`);
      const errors: string[] = [];
      const errorSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
        errors.push(String(msg));
      });
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as never);
      try {
        expect(() => loadArchonEnv(repoDir)).toThrow('process.exit called');
        expect(errors.join('\n')).toContain(`${repoEnv} sets ${key}`);
        // Refused before anything from the file is applied.
        expect(process.env.ARCHON_HOME).toBe(archonHomeDir);
        expect(process.env.TEST_EL_REPO_ONLY).toBeUndefined();
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  }

  it('refuses a refused key in any case on Windows, where env names ignore case', () => {
    const repoEnv = join(repoDir, '.archon', '.env');
    writeFileSync(repoEnv, `path=${join(tmpRoot, 'elsewhere')}\n`);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    try {
      expect(() => loadArchonEnv(repoDir)).toThrow('process.exit called');
      expect(errors.join('\n')).toContain(`${repoEnv} sets path`);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      delete process.env.path;
    }
  });

  it('lets the user-scope .env set the keys a repo may not', () => {
    const userPath = join(tmpRoot, 'user-bin');
    writeFileSync(join(archonHomeDir, '.env'), `PATH=${userPath}\n`);

    loadArchonEnv(repoDir);

    expect(process.env.PATH).toBe(userPath);
  });

  it('reads plugins from the ARCHON_HOME the process environment sets', () => {
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_REPO_ONLY=from-repo\n');

    loadArchonEnv(repoDir);

    expect(getPluginsPath()).toBe(join(archonHomeDir, 'plugins'));
  });

  it('emits loaded lines when LOG_LEVEL=trace', () => {
    process.env.LOG_LEVEL = 'trace';
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');

    loadArchonEnv(repoDir);

    const loaded = homeScopeLoadedLines();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toContain('loaded 1 keys');
    expect(loaded[0]).toContain(join('archon-home', '.env'));
  });

  it('does not emit loaded lines when ARCHON_VERBOSE_BOOT is set to a non-"1" value', () => {
    process.env.ARCHON_VERBOSE_BOOT = 'true';
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');

    loadArchonEnv(repoDir);

    const anyLoaded = stderrWrites.find(s => s.includes('[archon] loaded'));
    expect(anyLoaded).toBeUndefined();
  });
});

describe('LOG_LEVEL from an Archon env file', () => {
  let levelBefore: string;
  beforeEach(() => {
    levelBefore = rootLogger.level;
    resetLogLevelOverride();
  });
  afterEach(() => {
    rootLogger.level = levelBefore;
  });

  it('applies the user-scope value to the root logger', () => {
    rootLogger.level = 'info';
    writeFileSync(join(archonHomeDir, '.env'), 'LOG_LEVEL=debug\n');

    loadArchonEnv(repoDir);

    expect(getLogLevel()).toBe('debug');
  });

  it('keeps a level the caller already chose with setLogLevel', () => {
    setLogLevel('warn');
    writeFileSync(join(archonHomeDir, '.env'), 'LOG_LEVEL=debug\n');

    loadArchonEnv(repoDir);

    expect(getLogLevel()).toBe('warn');
  });

  it('lets the repo-scope value win over the user scope', () => {
    rootLogger.level = 'info';
    writeFileSync(join(archonHomeDir, '.env'), 'LOG_LEVEL=debug\n');
    writeFileSync(join(repoDir, '.archon', '.env'), 'LOG_LEVEL=error\n');

    loadArchonEnv(repoDir);

    expect(getLogLevel()).toBe('error');
  });
});

describe('getArchonEnvNames', () => {
  it('names both files declare, without calling loadArchonEnv first', () => {
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\n');
    writeFileSync(join(repoDir, '.archon', '.env'), 'TEST_EL_REPO_ONLY=from-repo\n');

    const names = getArchonEnvNames(repoDir);

    expect([...names].sort()).toEqual(['TEST_EL_HOME_ONLY', 'TEST_EL_REPO_ONLY']);
    // A read-only lookup: nothing from either file reaches process.env.
    expect(process.env.TEST_EL_HOME_ONLY).toBeUndefined();
    expect(process.env.TEST_EL_REPO_ONLY).toBeUndefined();
  });

  it('excludes an ambient process.env var that neither file declares', () => {
    process.env.TEST_EL_OTHER = 'inherited-from-shell-or-ci';

    const names = getArchonEnvNames(repoDir);

    expect(names.has('TEST_EL_OTHER')).toBe(false);
  });

  it('returns an empty set when neither file exists', () => {
    expect(getArchonEnvNames(repoDir).size).toBe(0);
  });
});

describe('loadArchonEnv — stripped-keys notice (#6362)', () => {
  /** One boot: strip the project's env files, then load Archon's, as each entry point does. */
  function boot(cwd: string = repoDir): string[] {
    stderrWrites.length = 0;
    stripCwdEnv(cwd);
    loadArchonEnv(cwd);
    return stderrWrites.filter(s => s.startsWith('[archon] stripped'));
  }

  it('explains the strip on the first boot in a project, then stays quiet while still stripping', () => {
    writeFileSync(join(repoDir, '.env'), 'TEST_EL_OTHER=a\n');

    const [line, ...rest] = boot();
    expect(rest).toEqual([]);
    expect(line).toStartWith(`[archon] stripped 1 key from ${repoDir} (.env). `);
    expect(line).toContain("does not load a target repository's .env files");

    process.env.TEST_EL_OTHER = 'from-shell';
    expect(boot()).toEqual([]);
    expect(process.env.TEST_EL_OTHER).toBeUndefined();
  });

  it('prints again when a key or file is added or renamed, but not when only a value changes', () => {
    const env = join(repoDir, '.env');
    writeFileSync(env, 'TEST_EL_OTHER=a\n');
    expect(boot()).toHaveLength(1);

    writeFileSync(env, 'TEST_EL_OTHER=changed\n');
    expect(boot()).toEqual([]);

    writeFileSync(env, 'TEST_EL_OVERLAP=a\n');
    expect(boot()).toHaveLength(1);

    rmSync(env);
    writeFileSync(join(repoDir, '.env.local'), 'TEST_EL_OVERLAP=a\n');
    expect(boot()[0]).toContain('(.env.local)');

    writeFileSync(env, 'TEST_EL_OTHER=a\n');
    expect(boot()[0]).toContain('(.env, .env.local)');
    expect(boot()).toEqual([]);
  });

  it('prints again when the env files come back after a boot without them', () => {
    const env = join(repoDir, '.env');
    writeFileSync(env, 'TEST_EL_OTHER=a\n');
    expect(boot()).toHaveLength(1);
    rmSync(env);
    expect(boot()).toEqual([]);
    writeFileSync(env, 'TEST_EL_OTHER=a\n');
    expect(boot()).toHaveLength(1);
  });

  it('gives each project its own first notice', () => {
    const otherRepo = join(tmpRoot, 'other-repo');
    mkdirSync(otherRepo, { recursive: true });
    writeFileSync(join(repoDir, '.env'), 'TEST_EL_OTHER=a\n');
    writeFileSync(join(otherRepo, '.env'), 'TEST_EL_OTHER=a\n');
    expect(boot()).toHaveLength(1);
    expect(boot(otherRepo)).toHaveLength(1);
    expect(boot()).toEqual([]);
  });

  it('prints on every boot under verbose boot', () => {
    writeFileSync(join(repoDir, '.env'), 'TEST_EL_OTHER=a\n');
    process.env.ARCHON_VERBOSE_BOOT = '1';
    expect(boot()).toHaveLength(1);
    expect(boot()).toHaveLength(1);
  });

  it('still prints when the Archon home cannot be written', () => {
    const homeIsAFile = join(tmpRoot, 'home-file');
    writeFileSync(homeIsAFile, '');
    process.env.ARCHON_HOME = homeIsAFile;
    writeFileSync(join(repoDir, '.env'), 'TEST_EL_OTHER=a\n');
    expect(boot()).toHaveLength(1);
    expect(boot()).toHaveLength(1);
  });

  describe('debug log record', () => {
    let events: Array<Record<string, unknown>>;
    beforeEach(() => {
      events = [];
      setLogSink(line => events.push(JSON.parse(line) as Record<string, unknown>));
      setLogLevel('debug');
    });
    afterEach(() => {
      setLogSink(undefined);
      setLogLevel('info');
      resetLogLevelOverride();
    });

    const stripped = (): Array<Record<string, unknown>> =>
      events.filter(e => e.msg === 'cwd_env.stripped');

    it('logs the strip on a boot whose operator line is suppressed, without values', () => {
      writeFileSync(join(repoDir, '.env'), 'TEST_EL_OTHER=secret-value-6362\n');
      expect(boot()).toHaveLength(1);
      events.length = 0;

      expect(boot()).toEqual([]);
      expect(stripped()).toEqual([
        expect.objectContaining({ cwd: repoDir, files: ['.env'], keys: ['TEST_EL_OTHER'] }),
      ]);
      const state = readFileSync(join(archonHomeDir, 'cwd-env-notice.json'), 'utf-8');
      for (const out of [JSON.stringify(events), stderrWrites.join(''), state]) {
        expect(out).not.toContain('secret-value-6362');
      }
      expect(state).not.toContain('TEST_EL_OTHER');
    });

    it('logs the strip before a refused repo-scope env file stops startup', () => {
      writeFileSync(join(repoDir, '.env'), 'TEST_EL_OTHER=a\n');
      writeFileSync(join(repoDir, '.archon', '.env'), 'PATH=/tmp/evil\n');
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as never);
      try {
        stripCwdEnv(repoDir);
        expect(() => loadArchonEnv(repoDir)).toThrow('process.exit called');
      } finally {
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
      expect(stripped()).toHaveLength(1);
    });
  });

  it('is shown once per project across separate processes', () => {
    const home = join(tmpRoot, 'process-home');
    const projects = [join(tmpRoot, 'project-a'), join(tmpRoot, 'project-b')];
    for (const project of projects) {
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, '.env'), 'TEST_EL_OTHER=a\n');
    }
    const probe = join(tmpRoot, 'probe.ts');
    writeFileSync(
      probe,
      `import '${pathToFileURL(join(import.meta.dir, 'strip-cwd-env-boot.ts')).href}';\n` +
        `import { loadArchonEnv } from '${pathToFileURL(join(import.meta.dir, 'env-loader.ts')).href}';\n` +
        'loadArchonEnv(process.cwd());\n'
    );
    const run = (cwd: string): number =>
      spawnSync(process.execPath, [probe], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ARCHON_HOME: home, ARCHON_VERBOSE_BOOT: '', LOG_LEVEL: '' },
      })
        .stderr.split('\n')
        .filter(line => line.startsWith('[archon] stripped')).length;

    expect([run(projects[0]), run(projects[0]), run(projects[1])]).toEqual([1, 0, 1]);
  });
});
