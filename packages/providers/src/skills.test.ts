import { describe, test, expect, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadResolvedSkills, resolveSkillReferences } from './skills';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-skills-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(root: string, name: string, content = 'Instructions'): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n\n${content}\n`
  );
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('skill resolution', () => {
  test('resolves skill names from configured roots before defaults', async () => {
    const cwd = await makeTempDir();
    const configuredRoot = join(cwd, 'custom-skills');
    const skillDir = await writeSkill(configuredRoot, 'alpha');

    const result = await resolveSkillReferences(cwd, ['alpha'], {
      skillRoots: [configuredRoot],
    });

    expect(result.missing).toEqual([]);
    expect(result.resolved).toEqual([
      {
        ref: 'alpha',
        name: 'alpha',
        dirPath: skillDir,
        skillPath: join(skillDir, 'SKILL.md'),
      },
    ]);
  });

  test('resolves explicit directories and SKILL.md paths', async () => {
    const cwd = await makeTempDir();
    const skillsRoot = join(cwd, 'skills');
    const alphaDir = await writeSkill(skillsRoot, 'alpha');
    const bravoDir = await writeSkill(skillsRoot, 'bravo');

    const result = await resolveSkillReferences(cwd, [alphaDir, join(bravoDir, 'SKILL.md')]);

    expect(result.missing).toEqual([]);
    expect(result.resolved.map(skill => skill.skillPath)).toEqual([
      join(alphaDir, 'SKILL.md'),
      join(bravoDir, 'SKILL.md'),
    ]);
  });

  test('reports searched paths for missing skills', async () => {
    const cwd = await makeTempDir();
    const configuredRoot = join(cwd, 'custom-skills');

    const result = await resolveSkillReferences(cwd, ['missing'], {
      skillRoots: [configuredRoot],
    });

    expect(result.resolved).toEqual([]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.ref).toBe('missing');
    expect(result.missing[0]?.searchedPaths[0]).toBe(join(configuredRoot, 'missing', 'SKILL.md'));
  });

  test('loads skill content and frontmatter name', async () => {
    const cwd = await makeTempDir();
    const skillDir = await writeSkill(join(cwd, '.agents', 'skills'), 'alpha', 'Use alpha.');
    const result = await resolveSkillReferences(cwd, ['alpha']);

    const loaded = await loadResolvedSkills(result.resolved);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('alpha');
    expect(loaded[0]?.content).toContain('Use alpha.');
    expect(loaded[0]?.skillPath).toBe(join(skillDir, 'SKILL.md'));
  });
});
