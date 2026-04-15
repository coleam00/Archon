import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { BUNDLED_SKILL_FILES } from './bundled-skill';

const repoRoot = resolve(import.meta.dir, '../../..');
const bundledSkillRoot = join(repoRoot, '.claude', 'skills', 'archon');

function listFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  return entries
    .flatMap(entry => {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        return listFiles(root, absolutePath);
      }
      return [relative(root, absolutePath)];
    })
    .sort();
}

describe('bundled Archon skill assets', () => {
  it('bundles every file from the installed .claude Archon skill tree', () => {
    const skillFiles = listFiles(bundledSkillRoot);
    const bundledFiles = Object.keys(BUNDLED_SKILL_FILES).sort();

    expect(bundledFiles).toEqual(skillFiles);

    for (const relativePath of skillFiles) {
      const expectedContent = readFileSync(join(bundledSkillRoot, relativePath), 'utf-8');
      expect(BUNDLED_SKILL_FILES[relativePath]).toBe(expectedContent);
    }
  });
});
