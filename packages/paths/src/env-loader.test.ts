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
let stderrSpy: ReturnType<typeof spyOn>;
let stderrWrites: string[];
let consoleErrorSpy: ReturnType<typeof spyOn>;
let consoleErrorMessages: string[];

beforeEach(() => {
  mkdirSync(archonHomeDir, { recursive: true });
  mkdirSync(join(repoDir, '.archon'), { recursive: true });

  originalArchonHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = archonHomeDir;

  for (const k of TEST_KEYS) delete process.env[k];

  stderrWrites = [];
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });

  consoleErrorMessages = [];
  consoleErrorSpy = spyOn(console, 'error').mockImplementation((msg: unknown) => {
    consoleErrorMessages.push(String(msg));
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });

  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;

  for (const k of TEST_KEYS) delete process.env[k];
});

describe('loadArchonEnv', () => {
  it('loads keys from ~/.archon/.env and emits a [archon] loaded line', () => {
    writeFileSync(join(archonHomeDir, '.env'), 'TEST_EL_HOME_ONLY=from-home\nTEST_EL_OTHER=keep\n');

    loadArchonEnv(repoDir);

    expect(process.env.TEST_EL_HOME_ONLY).toBe('from-home');
    expect(process.env.TEST_EL_OTHER).toBe('keep');
    const line = stderrWrites.find(s => s.includes('loaded') && s.includes('from ~/'));
    expect(line).toBeDefined();
    expect(line).toContain('loaded 2 keys from ~/');
  });

  it('loads keys from <cwd>/.archon/.env and marks it as repo scope', () => {
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

    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      expect(() => loadArchonEnv(repoDir)).toThrow('process.exit called');
      const msg = consoleErrorMessages.find(s => s.startsWith('Error loading .env'));
      expect(msg).toBeDefined();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
