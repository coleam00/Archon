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
const SKILL_DESCRIPTION_MAX_CHARS = 1024;

const CHECK_ONLY = process.argv.includes('--check');

function listSkillFiles(dir: string, base: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listSkillFiles(full, base) : [relative(base, full)];
  });
}

function extractFrontmatter(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== '---') {
    return null;
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  return endIndex === -1 ? null : lines.slice(1, endIndex).join('\n');
}

function trimBlockIndent(lines: string[]): string {
  const indentedLines = lines.filter(line => line.trim().length > 0);
  const indent =
    indentedLines.length === 0
      ? 0
      : Math.min(...indentedLines.map(line => /^\s*/.exec(line)?.[0].length ?? 0));

  return lines
    .map(line => line.slice(Math.min(indent, line.length)))
    .join('\n')
    .trimEnd();
}

function extractSkillDescription(markdown: string): string | null {
  const frontmatter = extractFrontmatter(markdown);
  if (frontmatter === null) {
    return null;
  }

  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^description:\s*(.*)$/.exec(lines[i]);
    if (match === null) {
      continue;
    }

    const value = match[1].trim();
    if (value !== '|') {
      return value;
    }

    const blockLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].length > 0 && !/^\s/.test(lines[j])) {
        break;
      }
      blockLines.push(lines[j]);
    }
    return trimBlockIndent(blockLines);
  }

  return null;
}

function validateSkillDescription(skill: string): string[] {
  const skillMdPath = join(SKILLS_DIR, skill, 'SKILL.md');
  const relativePath = relative(REPO_ROOT, skillMdPath);
  let markdown: string;

  try {
    markdown = readFileSync(skillMdPath, 'utf-8');
  } catch {
    return [`${relativePath}: missing SKILL.md`];
  }

  const description = extractSkillDescription(markdown);
  if (description === null) {
    return [`${relativePath}: missing description in frontmatter`];
  }
  if (description.length === 0) {
    return [`${relativePath}: description must not be empty`];
  }
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return [
      `${relativePath}: description is ${description.length} characters; maximum is ${SKILL_DESCRIPTION_MAX_CHARS}`,
    ];
  }

  return [];
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
const descriptionErrors = BUNDLED_SKILLS.flatMap(validateSkillDescription);
const validationErrors: string[] = [];

if (missing.length > 0) {
  validationErrors.push(
    `bundled-skill.ts is missing these files:\n${missing.map(f => `  - ${f}`).join('\n')}\n\n` +
      `Add a corresponding import + bundled map entry to\n  ${relative(REPO_ROOT, BUNDLED_SKILL_PATH)}`
  );
}

if (descriptionErrors.length > 0) {
  validationErrors.push(
    `Bundled skill description validation failed:\n${descriptionErrors.map(e => `  - ${e}`).join('\n')}`
  );
}

if (validationErrors.length > 0) {
  console.error(validationErrors.join('\n\n'));
  process.exit(CHECK_ONLY ? 2 : 1);
}

console.log(
  `bundled-skill.ts is up to date (${skillFiles.length} files across ${BUNDLED_SKILLS.length} skills; descriptions <= ${SKILL_DESCRIPTION_MAX_CHARS} chars).`
);
