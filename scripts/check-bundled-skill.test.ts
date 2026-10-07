import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { join } from 'node:path';
import { MAX_SKILL_DESCRIPTION_LENGTH, validateSkillDescription } from './check-bundled-skill';

describe('bundled skill metadata', () => {
  test('accepts the bundled archon-cli skill description', () => {
    const skill = readFileSync(
      join(import.meta.dir, '..', '.claude', 'skills', 'archon-cli', 'SKILL.md'),
      'utf8'
    );

    expect(validateSkillDescription('archon-cli', skill)).toBeUndefined();
  });

  test('rejects an empty description', () => {
    expect(validateSkillDescription('fixture', '---\ndescription: ""\n---\n')).toContain(
      'non-empty'
    );
  });

  test('rejects a description longer than the Agent Skills limit', () => {
    const skill = `---\ndescription: ${'a'.repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1)}\n---\n`;

    expect(validateSkillDescription('fixture', skill)).toContain(
      `${MAX_SKILL_DESCRIPTION_LENGTH + 1}-character`
    );
  });
});

const repoRoot = join(import.meta.dir, '..');
const skillPath = '.claude/skills/archon-cli';
const modulePath = 'packages/cli/src/bundled-skill.ts';
const checkerPath = 'scripts/check-bundled-skill.ts';
const bundledSource = readFileSync(join(repoRoot, modulePath), 'utf8');
const skillFiles = [
  ...new Bun.Glob('**/*').scanSync({ cwd: join(repoRoot, skillPath), onlyFiles: true }),
].sort();
const track = trackTempRoots();

function fixture(): string {
  const root = track(mkdtempSync(join(tmpdir(), 'bundled-skill-check-')));
  for (const path of [skillPath, modulePath, checkerPath]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  }
  return root;
}

async function runChecker(root: string, args = ['--check']) {
  const child = Bun.spawn([process.execPath, join(root, checkerPath), ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function removeLine(root: string, matches: (line: string) => boolean): void {
  const lines = bundledSource.split('\n');
  expect(lines.filter(matches)).toHaveLength(1);
  writeFileSync(join(root, modulePath), lines.filter(line => !matches(line)).join('\n'));
}

describe('bundled skill checker command', () => {
  test('accepts the unchanged bundle and ignores local skills', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude/skills/local'), { recursive: true });
    writeFileSync(join(root, '.claude/skills/local/SKILL.md'), 'local skill');
    const result = await runChecker(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${skillFiles.length} files`);
  });

  for (const file of skillFiles) {
    test(`rejects a missing map entry for ${file} with its import retained`, async () => {
      const root = fixture();
      removeLine(root, line => line.trimStart().startsWith(`'${file}':`));
      const result = await runChecker(root);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(file);
    });

    test(`rejects a missing import for ${file} with its map entry retained`, async () => {
      const root = fixture();
      removeLine(root, line => line.startsWith('import ') && line.includes(`/archon-cli/${file}'`));
      const result = await runChecker(root);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe('');
    });
  }

  test('rejects an unregistered nested file', async () => {
    const root = fixture();
    mkdirSync(join(root, skillPath, 'new'), { recursive: true });
    writeFileSync(join(root, skillPath, 'new/reference.md'), 'new reference');
    const result = await runChecker(root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('new/reference.md');
  });

  test('rejects a map key without a corresponding file', async () => {
    const root = fixture();
    writeFileSync(
      join(root, modulePath),
      bundledSource.replace(
        "  'SKILL.md': router,",
        "  'SKILL.md': router,\n  'retired.md': router,"
      )
    );
    const result = await runChecker(root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('retired.md');
  });

  test('uses exit 1 for validation failures without --check', async () => {
    const root = fixture();
    removeLine(root, line => line.trimStart().startsWith("'SKILL.md':"));
    const result = await runChecker(root, []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SKILL.md');
  });

  test('still rejects invalid skill metadata', async () => {
    const root = fixture();
    writeFileSync(join(root, skillPath, 'SKILL.md'), '---\ndescription: ""\n---\n');
    const result = await runChecker(root);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('non-empty');
  });
});
