#!/usr/bin/env bun
/**
 * Verifies that packages/cli/src/bundled-skill.ts embeds every file of the
 * Archon-distributed skill (.claude/skills/archon-cli/).
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
 *   0  bundled-skill.ts covers every file and each bundled skill has valid metadata
 *   1  validation failure (default mode)
 *   2  validation failure (--check mode, used by `bun run validate`)
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
/** Skills bundled into the binary and installed by `archon skill install`. */
const BUNDLED_SKILLS = ['archon-cli'];
const BUNDLED_SKILL_PATH = join(REPO_ROOT, 'packages', 'cli', 'src', 'bundled-skill.ts');
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

const CHECK_ONLY = process.argv.includes('--check');

function listSkillFiles(dir: string, base: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listSkillFiles(full, base) : [relative(base, full)];
  });
}

function hasDescription(metadata: unknown): metadata is { description: string } {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'description' in metadata &&
    typeof metadata.description === 'string'
  );
}

export function validateSkillDescription(skillName: string, content: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) {
    return `Bundled skill \`${skillName}\` must start with YAML frontmatter.`;
  }

  let metadata: unknown;
  try {
    metadata = Bun.YAML.parse(frontmatter[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Bundled skill \`${skillName}\` has invalid YAML frontmatter: ${message}`;
  }

  if (!hasDescription(metadata) || metadata.description.trim() === '') {
    return `Bundled skill \`${skillName}\` must have a non-empty frontmatter \`description\`.`;
  }

  if (metadata.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return `Bundled skill \`${skillName}\` has a ${metadata.description.length}-character frontmatter \`description\`; the limit is ${MAX_SKILL_DESCRIPTION_LENGTH}.`;
  }

  return undefined;
}

function checkBundledSkills(): void {
  // Paths are relative to .claude/skills/ so they keep the skill dir name
  // (e.g. `archon-cli/SKILL.md`). That makes the substring check match the
  // literal import paths in bundled-skill.ts. Normalize separators for Windows.
  const skillFiles = BUNDLED_SKILLS.flatMap(skill =>
    listSkillFiles(join(SKILLS_DIR, skill), SKILLS_DIR)
  )
    .map(f => f.replace(/\\/g, '/'))
    .sort();

  const bundledSrc = readFileSync(BUNDLED_SKILL_PATH, 'utf-8');
  // This is a substring check, so a stale string literal can satisfy it. It is a
  // safety net for missing bundled files, not structural verification of the map.
  const missing = skillFiles.filter(f => !bundledSrc.includes(f));
  const metadataErrors = BUNDLED_SKILLS.flatMap(skill => {
    const error = validateSkillDescription(
      skill,
      readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf-8')
    );
    return error ? [error] : [];
  });

  if (missing.length > 0 || metadataErrors.length > 0) {
    const errors = [
      missing.length > 0
        ? `bundled-skill.ts is missing these files:\n${missing.map(f => `  - ${f}`).join('\n')}\n\n` +
          `Add a corresponding import + bundled map entry to\n  ${relative(REPO_ROOT, BUNDLED_SKILL_PATH)}`
        : undefined,
      ...metadataErrors,
    ].filter((error): error is string => error !== undefined);
    console.error(errors.join('\n\n'));
    process.exit(CHECK_ONLY ? 2 : 1);
  }

  console.log(
    `bundled-skill.ts is up to date (${skillFiles.length} files across ${BUNDLED_SKILLS.length} skills), and bundled skill metadata is valid.`
  );
}

if (import.meta.main) checkBundledSkills();
