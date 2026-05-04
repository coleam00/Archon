#!/usr/bin/env bun
/**
 * Verifies that packages/cli/src/bundled-skill.ts embeds every file from
 * .claude/skills/archon/. The bundled-skill.ts file is hand-maintained
 * (uses Bun's `with { type: 'text' }` import attributes, which the
 * generator approach in scripts/generate-bundled-defaults.ts cannot
 * reproduce for the binary build). This script is the safety net.
 *
 * Usage:
 *   bun run scripts/check-bundled-skill.ts          # exit 1 if missing
 *   bun run scripts/check-bundled-skill.ts --check  # exit 2 if missing (CI)
 *
 * Exit codes:
 *   0  bundled-skill.ts covers every file under .claude/skills/archon/
 *   1  missing files (default mode)
 *   2  missing files (--check mode, used by `bun run validate`)
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SKILL_ROOT = join(REPO_ROOT, '.claude', 'skills', 'archon');
const BUNDLED_SKILL_PATH = join(REPO_ROOT, 'packages', 'cli', 'src', 'bundled-skill.ts');

const CHECK_ONLY = process.argv.includes('--check');

function listSkillFiles(dir: string, base: string = dir): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listSkillFiles(full, base) : [relative(base, full)];
  });
}

const skillFiles = listSkillFiles(SKILL_ROOT).sort();
const bundledSrc = readFileSync(BUNDLED_SKILL_PATH, 'utf-8');
const missing = skillFiles.filter(f => !bundledSrc.includes(f));

if (missing.length > 0) {
  console.error(
    `bundled-skill.ts is missing these files:\n${missing.map(f => `  - ${f}`).join('\n')}\n\n` +
      `Add a corresponding import + BUNDLED_SKILL_FILES entry to\n  ${relative(REPO_ROOT, BUNDLED_SKILL_PATH)}`
  );
  process.exit(CHECK_ONLY ? 2 : 1);
}

console.log(`bundled-skill.ts is up to date (${skillFiles.length} files).`);
