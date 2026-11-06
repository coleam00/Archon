import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { projectKeyForCodebase } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';
import { clearConfigCache } from '@archon/core/config/config-loader';
import { clearPlatformPolicies, setPlatformPolicies } from '@archon/core/platforms/registry';
import type { Codebase } from '@archon/core/schemas/codebase';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { projectCommand, projectConfigCommand, projectListCommand } from './project';

function codebase(overrides: Partial<Codebase> & Pick<Codebase, 'id' | 'name' | 'kind'>): Codebase {
  return {
    repository_url: null,
    default_cwd: `/repos/${overrides.id}`,
    default_branch: null,
    ai_assistant_type: null,
    commands: {},
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

const ROWS = [
  codebase({ id: 'cb-repo', name: 'acme/widget', kind: 'repo' }),
  codebase({ id: 'cb-folder', name: 'notes', kind: 'folder' }),
];

describe('projectListCommand', () => {
  let logs: string[];
  let stdout: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logs = [];
    stdout = [];
    logSpy = spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string,
      callback?: () => void
    ) => {
      stdout.push(chunk);
      callback?.();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('emits each row with its project key', async () => {
    expect(await projectListCommand({ listCodebases: async () => ROWS }, { json: true })).toBe(0);

    const { projects } = JSON.parse(stdout.join('')) as { projects: Record<string, unknown>[] };
    expect(projects).toEqual(
      ROWS.map(row => ({
        ...JSON.parse(JSON.stringify(row)),
        key: projectKeyForCodebase(row, row.default_cwd),
      }))
    );
  });

  it('prints one line per project, or says none are registered', async () => {
    await projectListCommand({ listCodebases: async () => ROWS }, {});
    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain('cb-repo\trepo\tacme/widget');
    expect(logs[2]).toContain('cb-folder\tfolder\tnotes');

    logs = [];
    await projectListCommand({ listCodebases: async () => [] }, {});
    expect(logs).toEqual(['No projects registered.']);
  });

  it('refuses an unknown subcommand or a config without a project before opening the store', async () => {
    for (const args of [['show'], ['config'], ['config', 'a', 'b']]) {
      stdout = [];
      expect(await projectCommand(args, true)).toBe(1);
      expect(JSON.parse(stdout.join(''))).toEqual({
        ok: false,
        error: 'Usage: archon project list|config <id|name> [--json]',
      });
    }
  });
});

describe('projectConfigCommand', () => {
  const trackTempRoot = trackTempRoots();
  const ENV_SECRET = 'env-secret-sentinel-7f3a';
  const PATH_SECRET = '/assistant-path-sentinel-9c1e';
  const savedHome = process.env.ARCHON_HOME;
  let home: string;
  let project: string;
  let rows: Codebase[];
  let stdout: string[];
  let stdoutSpy: ReturnType<typeof spyOn>;

  registerBuiltinProviders();

  function store(): Parameters<typeof projectConfigCommand>[0] {
    return {
      listCodebaseClaims: async () => rows,
      getCodebase: async id => rows.find(row => row.id === id) ?? null,
    };
  }

  function files(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const root of [home, project])
      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }))
        if (entry.isFile()) {
          const path = join(entry.parentPath, entry.name);
          out[path] = readFileSync(path, 'utf8');
        }
    return out;
  }

  beforeEach(() => {
    setPlatformPolicies([]);
    clearConfigCache();
    home = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-home-')));
    project = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-project-')));
    process.env.ARCHON_HOME = home;
    writeFileSync(
      join(home, 'config.yaml'),
      "aliases:\n  '@planner': { provider: claude, model: haiku }\n  '@reviewer': { provider: claude, model: sonnet }\n"
    );
    mkdirSync(join(project, '.archon'));
    writeFileSync(
      join(project, '.archon', 'config.yaml'),
      `aliases:\n  '@planner': { provider: claude, model: opus }\nassistants:\n  codex:\n    additionalDirectories: ['${PATH_SECRET}']\nenv:\n  FORGE_SOURCE: gh\n  SECRET_TOKEN: ${ENV_SECRET}\n`
    );
    rows = [codebase({ id: 'cb-repo', name: 'acme/widget', kind: 'repo', default_cwd: project })];
    stdout = [];
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string,
      callback?: () => void
    ) => {
      stdout.push(chunk);
      callback?.();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
    clearConfigCache();
    clearPlatformPolicies();
  });

  it("prints the project's merged config with env key names only, and writes nothing", async () => {
    const before = files();
    expect(await projectConfigCommand(store(), 'cb-repo', { json: true })).toBe(0);
    const text = stdout.join('');
    const view = JSON.parse(text) as {
      project: unknown;
      config: { aliases: unknown };
      envKeys: string[];
    };
    expect(view.project).toEqual({ id: 'cb-repo', name: 'acme/widget' });
    expect(view.config.aliases).toEqual({
      '@planner': { provider: 'claude', model: 'opus' },
      '@reviewer': { provider: 'claude', model: 'sonnet' },
    });
    expect(view.envKeys).toEqual(['FORGE_SOURCE', 'SECRET_TOKEN']);
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain(PATH_SECRET);
    expect(files()).toEqual(before);
  });

  it('finds a project by exact name and prints YAML without --json', async () => {
    expect(await projectConfigCommand(store(), 'acme/widget', {})).toBe(0);
    const view = Bun.YAML.parse(stdout.join('')) as { project: { id: string }; envKeys: string[] };
    expect(view.project.id).toBe('cb-repo');
    expect(view.envKeys).toEqual(['FORGE_SOURCE', 'SECRET_TOKEN']);
    expect(stdout.join('')).not.toContain(ENV_SECRET);
    expect(stdout.join('')).not.toContain(PATH_SECRET);
  });

  it('does not create a missing global config', async () => {
    rmSync(join(home, 'config.yaml'));
    expect(await projectConfigCommand(store(), 'cb-repo', { json: true })).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses an ambiguous name and an unknown project', async () => {
    rows.push(codebase({ id: 'cb-other', name: 'acme/widget', kind: 'repo' }));
    expect(await projectConfigCommand(store(), 'acme/widget', { json: true })).toBe(1);
    expect(JSON.parse(stdout.join('')).error).toContain('cb-repo, cb-other');

    stdout = [];
    expect(await projectConfigCommand(store(), 'nope', { json: true })).toBe(1);
    expect(JSON.parse(stdout.join('')).error).toContain('archon project list');
  });
});
