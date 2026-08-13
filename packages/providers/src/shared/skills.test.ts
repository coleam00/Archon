import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudeSkillDirectories, resolveSkillDirectories } from './skills';

type FakeWorld = {
  root: string;
  cwd: string;
  home: string;
  stageSkill: (under: 'cwd' | 'home', subdir: '.agents' | '.claude', name: string) => string;
};

/**
 * Stages a temp cwd and HOME so the resolver's filesystem reads are isolated
 * per test. Each test gets its own `cwd/.agents/skills/` etc. tree to populate
 * as needed.
 */
function makeFakeWorld(): FakeWorld {
  const root = mkdtempSync(join(tmpdir(), 'archon-skills-test-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });

  const stageSkill = (
    under: 'cwd' | 'home',
    subdir: '.agents' | '.claude',
    name: string
  ): string => {
    const base = under === 'cwd' ? cwd : home;
    const dir = join(base, subdir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);
    return dir;
  };

  return { root, cwd, home, stageSkill };
}

describe('resolveSkillDirectories', () => {
  const originalHome = process.env.HOME;
  let fake: ReturnType<typeof makeFakeWorld>;

  beforeEach(() => {
    fake = makeFakeWorld();
    process.env.HOME = fake.home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fake.root, { recursive: true, force: true });
  });

  test('returns empty paths and missing for undefined input', () => {
    expect(resolveSkillDirectories(fake.cwd, undefined)).toEqual({ paths: [], missing: [] });
  });

  test('returns empty paths and missing for empty array', () => {
    expect(resolveSkillDirectories(fake.cwd, [])).toEqual({ paths: [], missing: [] });
  });

  test('skips empty strings and non-string entries', () => {
    // Cast through unknown so we can exercise the runtime guard against
    // wonky callers; the type system rules these out at compile time.
    const input = ['', '  ', null, undefined, 42] as unknown as string[];
    expect(resolveSkillDirectories(fake.cwd, input)).toEqual({ paths: [], missing: [] });
  });

  test('reports a missing skill that nothing on disk provides', () => {
    const result = resolveSkillDirectories(fake.cwd, ['nonexistent']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['nonexistent']);
  });

  test('resolves a skill staged under cwd/.agents/skills', () => {
    const dir = fake.stageSkill('cwd', '.agents', 'alpha');
    const result = resolveSkillDirectories(fake.cwd, ['alpha']);
    expect(result.paths).toEqual([dir]);
    expect(result.missing).toEqual([]);
  });

  test('falls back to cwd/.claude/skills when .agents misses', () => {
    const dir = fake.stageSkill('cwd', '.claude', 'beta');
    const result = resolveSkillDirectories(fake.cwd, ['beta']);
    expect(result.paths).toEqual([dir]);
    expect(result.missing).toEqual([]);
  });

  test('falls back to home/.agents/skills when both cwd locations miss', () => {
    const dir = fake.stageSkill('home', '.agents', 'gamma');
    const result = resolveSkillDirectories(fake.cwd, ['gamma']);
    expect(result.paths).toEqual([dir]);
    expect(result.missing).toEqual([]);
  });

  test('prefers cwd over home when the same name exists in both', () => {
    const cwdDir = fake.stageSkill('cwd', '.agents', 'delta');
    fake.stageSkill('home', '.agents', 'delta');
    const result = resolveSkillDirectories(fake.cwd, ['delta']);
    expect(result.paths).toEqual([cwdDir]);
    expect(result.missing).toEqual([]);
  });

  test('deduplicates repeated names', () => {
    const dir = fake.stageSkill('cwd', '.agents', 'epsilon');
    const result = resolveSkillDirectories(fake.cwd, ['epsilon', 'epsilon', 'epsilon']);
    expect(result.paths).toEqual([dir]);
    expect(result.missing).toEqual([]);
  });

  test('rejects absolute-path names', () => {
    const result = resolveSkillDirectories(fake.cwd, ['/etc/passwd']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['/etc/passwd']);
  });

  test('rejects nested-path names', () => {
    const result = resolveSkillDirectories(fake.cwd, ['foo/bar']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['foo/bar']);
  });

  test('rejects parent-traversal names', () => {
    const result = resolveSkillDirectories(fake.cwd, ['..', '../escape']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['..', '../escape']);
  });

  test('treats directories without a SKILL.md as missing', () => {
    // Stage the directory itself but omit the SKILL.md file — the resolver
    // requires the marker to consider it a skill.
    const partialDir = join(fake.cwd, '.agents', 'skills', 'zeta');
    mkdirSync(partialDir, { recursive: true });
    const result = resolveSkillDirectories(fake.cwd, ['zeta']);
    expect(result.paths).toEqual([]);
    expect(result.missing).toEqual(['zeta']);
  });
});

describe('resolveClaudeSkillDirectories', () => {
  const originalHome = process.env.HOME;
  let fake: ReturnType<typeof makeFakeWorld>;

  beforeEach(() => {
    fake = makeFakeWorld();
    process.env.HOME = fake.home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fake.root, { recursive: true, force: true });
  });

  test('resolves project and user Claude-native skills', () => {
    const project = fake.stageSkill('cwd', '.claude', 'project-skill');
    const user = fake.stageSkill('home', '.claude', 'user-skill');

    expect(resolveClaudeSkillDirectories(fake.cwd, ['project-skill', 'user-skill'])).toEqual({
      paths: [project, user],
      missing: [],
    });
  });

  test('does not accept an agents-only installation', () => {
    fake.stageSkill('cwd', '.agents', 'agents-only');

    expect(resolveClaudeSkillDirectories(fake.cwd, ['agents-only'])).toEqual({
      paths: [],
      missing: ['agents-only'],
    });
  });

  test('honors a custom Claude config directory for user skills', () => {
    const customConfig = join(fake.root, 'custom-claude');
    const skill = join(customConfig, 'skills', 'custom-skill');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# custom\n');

    expect(
      resolveClaudeSkillDirectories(fake.cwd, ['custom-skill'], {
        userConfigDir: customConfig,
      })
    ).toEqual({ paths: [skill], missing: [] });
  });

  test('can restrict discovery to project skills for isolated execution', () => {
    fake.stageSkill('home', '.claude', 'user-only');

    expect(resolveClaudeSkillDirectories(fake.cwd, ['user-only'], { includeUser: false })).toEqual({
      paths: [],
      missing: ['user-only'],
    });
  });

  test('can exclude project skills when project settings are disabled', () => {
    fake.stageSkill('cwd', '.claude', 'project-only');

    expect(
      resolveClaudeSkillDirectories(fake.cwd, ['project-only'], { includeProject: false })
    ).toEqual({ paths: [], missing: ['project-only'] });
  });
});
