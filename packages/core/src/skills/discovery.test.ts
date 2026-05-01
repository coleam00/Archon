import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverSkills } from './discovery';

/**
 * These tests build temporary directory trees that mimic the real layout
 * (`~/.claude/skills/<name>/SKILL.md` and `<cwd>/.claude/skills/<name>/SKILL.md`)
 * and override `HOME` so the discovery code looks at the temp tree instead of
 * the developer's actual `~/.claude/skills/`.
 */

const SKILL_MD_TEMPLATE = (name: string, desc: string): string => `---
name: ${name}
description: ${desc}
---

Body of ${name}.
`;

async function setupSkill(rootDir: string, name: string, desc: string): Promise<string> {
  const skillDir = join(rootDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), SKILL_MD_TEMPLATE(name, desc), 'utf8');
  return skillDir;
}

describe('discoverSkills', () => {
  let tempHome: string;
  let tempProject: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'skills-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'skills-proj-'));
    await mkdir(join(tempHome, '.claude', 'skills'), { recursive: true });
    await mkdir(join(tempProject, '.claude', 'skills'), { recursive: true });
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('returns empty result when no skills exist', async () => {
    const result = await discoverSkills(tempProject);
    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('discovers global skills', async () => {
    const globalDir = join(tempHome, '.claude', 'skills');
    await setupSkill(globalDir, 'foo', 'first global skill');
    await setupSkill(globalDir, 'bar', 'second global skill');

    const result = await discoverSkills(tempProject);
    expect(result.skills.map(s => s.name).sort()).toEqual(['bar', 'foo']);
    expect(result.skills.every(s => s.source === 'global')).toBe(true);
  });

  test('discovers project skills', async () => {
    const projDir = join(tempProject, '.claude', 'skills');
    await setupSkill(projDir, 'baz', 'project-only');

    const result = await discoverSkills(tempProject);
    expect(result.skills.map(s => s.name)).toEqual(['baz']);
    expect(result.skills[0]?.source).toBe('project');
  });

  test('project entries override global entries by name', async () => {
    await setupSkill(join(tempHome, '.claude', 'skills'), 'shared', 'global version');
    await setupSkill(join(tempProject, '.claude', 'skills'), 'shared', 'project version');

    const result = await discoverSkills(tempProject);
    const shared = result.skills.find(s => s.name === 'shared');
    expect(shared?.source).toBe('project');
    expect(shared?.description).toBe('project version');
  });

  test('detects symlinked skills', async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'skills-target-'));
    try {
      const targetSkill = await setupSkill(targetRepo, 'linked', 'target skill');
      const linkPath = join(tempHome, '.claude', 'skills', 'linked');
      await symlink(targetSkill, linkPath);

      const result = await discoverSkills(tempProject);
      const linked = result.skills.find(s => s.name === 'linked');
      expect(linked?.isSymlink).toBe(true);
      // macOS resolves /var/... to /private/var/... — compare against realpath.
      expect(linked?.realPath).toBe(await realpath(targetSkill));
    } finally {
      await rm(targetRepo, { recursive: true, force: true });
    }
  });

  test('captures malformed SKILL.md as parseError without aborting', async () => {
    const goodDir = await setupSkill(join(tempHome, '.claude', 'skills'), 'good', 'fine');
    expect(goodDir).toContain('good');

    const broken = join(tempHome, '.claude', 'skills', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'SKILL.md'), 'no frontmatter here, just text\n', 'utf8');

    const result = await discoverSkills(tempProject);
    const brokenEntry = result.skills.find(s => s.name === 'broken');
    expect(brokenEntry?.parseError).not.toBe(null);
    const goodEntry = result.skills.find(s => s.name === 'good');
    expect(goodEntry?.parseError).toBe(null);
  });

  test('skips directories without SKILL.md', async () => {
    const noSkill = join(tempHome, '.claude', 'skills', 'empty-dir');
    await mkdir(noSkill, { recursive: true });

    const result = await discoverSkills(tempProject);
    expect(result.skills.find(s => s.name === 'empty-dir')).toBeUndefined();
  });

  test('reports hasScripts/hasReferences/hasAssets', async () => {
    const skillDir = await setupSkill(
      join(tempHome, '.claude', 'skills'),
      'rich',
      'has subfolders'
    );
    await mkdir(join(skillDir, 'scripts'));
    await mkdir(join(skillDir, 'references'));

    const result = await discoverSkills(tempProject);
    const rich = result.skills.find(s => s.name === 'rich');
    expect(rich?.hasScripts).toBe(true);
    expect(rich?.hasReferences).toBe(true);
    expect(rich?.hasAssets).toBe(false);
  });
});
