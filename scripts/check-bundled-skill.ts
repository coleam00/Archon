#!/usr/bin/env bun
/**
 * Verifies that packages/cli/src/bundled-skill.ts embeds every file of the
 * Archon-distributed skills (.claude/skills/archon/ and .claude/skills/manage-run/).
 * bundled-skill.ts is hand-maintained (Bun's `with { type: 'text' }` import
 * attributes, which the generator approach in scripts/generate-bundled-defaults.ts
 * cannot reproduce for the binary build). This script is the safety net.
 *
 * Only the BUNDLED_SKILLS allowlist is checked — the repo also carries local/dev
 * skill dirs under .claude/skills/ (playwright-cli, release, triage, …) that are
 * NOT shipped in the binary and must not be required here.
 *
 * Usage:
 *   bun run scripts/check-bundled-skill.ts          # exit 1 if missing
 *   bun run scripts/check-bundled-skill.ts --check  # exit 2 if missing (CI)
 *
 * Exit codes:
 *   0  bundled-skill.ts covers every file of the bundled skills
 *   1  missing files (default mode)
 *   2  missing files (--check mode, used by `bun run validate`)
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
/** Skills bundled into the binary and installed by `archon skill install`. */
const BUNDLED_SKILLS = ['archon', 'manage-run'];
const BUNDLED_SKILL_PATH = join(REPO_ROOT, 'packages', 'cli', 'src', 'bundled-skill.ts');

const CHECK_ONLY = process.argv.includes('--check');

function listSkillFiles(dir: string, base: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listSkillFiles(full, base) : [relative(base, full)];
  });
}

// Paths are relative to .claude/skills/ so they keep the skill dir name
// (e.g. `archon/SKILL.md`, `manage-run/references/commands.md`). That makes the
// substring check distinguish the two skills' identically-named files (both have
// a SKILL.md) and matches the literal import paths in bundled-skill.ts.
// Normalize to forward slashes so the substring check works on Windows.
const skillFiles = BUNDLED_SKILLS.flatMap(skill =>
  listSkillFiles(join(SKILLS_DIR, skill), SKILLS_DIR)
)
  .map(f => f.replace(/\\/g, '/'))
  .sort();

const bundledSrc = readFileSync(BUNDLED_SKILL_PATH, 'utf-8');
// NOTE: This is a substring check — a filename that appears in a comment or
// stale string literal will also pass. It's a safety net against missing imports,
// not a structural verification of the export map.
const missing = skillFiles.filter(f => !bundledSrc.includes(f));

if (missing.length > 0) {
  console.error(
    `bundled-skill.ts is missing these files:\n${missing.map(f => `  - ${f}`).join('\n')}\n\n` +
      `Add a corresponding import + bundled map entry to\n  ${relative(REPO_ROOT, BUNDLED_SKILL_PATH)}`
  );
  process.exit(CHECK_ONLY ? 2 : 1);
}

console.log(
  `bundled-skill.ts is up to date (${skillFiles.length} files across ${BUNDLED_SKILLS.length} skills).`
);
