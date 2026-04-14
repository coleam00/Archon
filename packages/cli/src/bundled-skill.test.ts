import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { BUNDLED_SKILL_FILES } from './bundled-skill';

const repoRoot = resolve(import.meta.dir, '../../..');
const canonicalRoot = join(repoRoot, '.agents', 'skills', 'archon');
const mirrorRoot = join(repoRoot, '.claude', 'skills', 'archon');

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
  it('keeps the .claude host skill as an exact mirror of the canonical .agents tree', () => {
    const canonicalFiles = listFiles(canonicalRoot);
    const mirrorFiles = listFiles(mirrorRoot);

    expect(mirrorFiles).toEqual(canonicalFiles);

    for (const relativePath of canonicalFiles) {
      const canonicalContent = readFileSync(join(canonicalRoot, relativePath), 'utf-8');
      const mirrorContent = readFileSync(join(mirrorRoot, relativePath), 'utf-8');
      expect(mirrorContent).toBe(canonicalContent);
    }
  });

  it('bundles every canonical Archon skill file', () => {
    const canonicalFiles = listFiles(canonicalRoot);
    const bundledFiles = Object.keys(BUNDLED_SKILL_FILES).sort();

    expect(bundledFiles).toEqual(canonicalFiles);
  });
});
