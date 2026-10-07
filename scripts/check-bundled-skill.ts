#!/usr/bin/env bun
/**
 * Verifies that the installer map contains exactly the files under
 * .claude/skills/archon-cli/ and that the skill metadata is valid.
 * Local/dev skills outside archon-cli are not shipped and are not checked.
 *
 * Exit codes: 0 on success, 1 on validation failure, or 2 with --check (CI).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { BUNDLED_SKILL_FILES } from '../packages/cli/src/bundled-skill';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SKILL_DIR = join(REPO_ROOT, '.claude', 'skills', 'archon-cli');
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
  const skillFiles = listSkillFiles(SKILL_DIR, SKILL_DIR)
    .map(file => file.replaceAll('\\', '/'))
    .sort();
  const diskPaths = new Set(skillFiles);
  const bundledPaths = new Set(Object.keys(BUNDLED_SKILL_FILES));
  const missing = skillFiles.filter(file => !bundledPaths.has(file));
  const unexpected = [...bundledPaths].filter(file => !diskPaths.has(file)).sort();
  const metadataError = validateSkillDescription(
    'archon-cli',
    readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  );

  if (missing.length > 0 || unexpected.length > 0 || metadataError) {
    const errors = [
      missing.length > 0
        ? `bundled-skill.ts is missing these files:\n${missing.map(f => `  - ${f}`).join('\n')}\n\n` +
          `Add a corresponding import + bundled map entry to\n  ${relative(REPO_ROOT, BUNDLED_SKILL_PATH)}`
        : undefined,
      unexpected.length > 0
        ? `bundled-skill.ts has entries without files on disk:\n${unexpected.map(file => `  - ${file}`).join('\n')}`
        : undefined,
      metadataError,
    ].filter((error): error is string => error !== undefined);
    console.error(errors.join('\n\n'));
    process.exit(CHECK_ONLY ? 2 : 1);
  }

  console.log(
    `bundled-skill.ts is up to date (${skillFiles.length} files for archon-cli), and bundled skill metadata is valid.`
  );
}

if (import.meta.main) checkBundledSkills();
