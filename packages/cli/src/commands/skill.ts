/**
 * Skill command - Install bundled Archon skill files into a project
 *
 * Writes the bundled SKILL.md, guides, references and examples into
 * <targetPath>/.claude/skills/archon/ so Claude Code picks up the skill
 * the next time the project is opened.
 *
 * Always overwrites existing files to ensure the latest skill version
 * shipped with the current Archon binary is installed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { BUNDLED_SKILL_FILES } from '../bundled-skill';

/**
 * Copy the bundled Archon skill files to <targetPath>/.claude/skills/archon/
 *
 * Pure file-system helper used by both the standalone `skill install` CLI
 * command and the interactive setup wizard.
 */
export function copyArchonSkill(targetPath: string): void {
  const skillRoot = join(targetPath, '.claude', 'skills', 'archon');
  for (const [relativePath, content] of Object.entries(BUNDLED_SKILL_FILES)) {
    const dest = join(skillRoot, relativePath);
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    writeFileSync(dest, content);
  }
}

/**
 * Install the bundled Archon skill into a project directory.
 *
 * Returns an exit code: 0 on success, 1 on failure.
 */
export async function skillInstallCommand(targetPath: string): Promise<number> {
  const absoluteTarget = resolve(targetPath);

  if (!existsSync(absoluteTarget)) {
    console.error(`Error: Directory does not exist: ${absoluteTarget}`);
    return 1;
  }

  const skillRoot = join(absoluteTarget, '.claude', 'skills', 'archon');
  const fileCount = Object.keys(BUNDLED_SKILL_FILES).length;

  console.log(`Installing Archon skill (${fileCount} files) into ${skillRoot}`);

  try {
    copyArchonSkill(absoluteTarget);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.error(`Error: Failed to install skill: ${err.message}`);
    return 1;
  }

  console.log('Done. Restart Claude Code to load the skill.');
  return 0;
}
