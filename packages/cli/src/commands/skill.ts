/**
 * Skill command - Install bundled Archon skill files into a project
 *
 * Writes the bundled `archon` skill (SKILL.md, guides, references, examples) and
 * the focused `manage-run` skill into <targetPath>/.claude/skills/<skill>/ (for
 * Claude Code) and <targetPath>/.agents/skills/<skill>/ (the canonical Codex
 * project-level skill path) so both Claude Code and Codex pick them up.
 *
 * Always overwrites existing files to ensure the latest skill version
 * shipped with the current Archon binary is installed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/** Write a skill's relative-path→content map under <skillRoot>, creating dirs as needed. */
function writeSkillFiles(skillRoot: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const dest = join(skillRoot, relativePath);
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    writeFileSync(dest, content);
  }
}

/**
 * Copy the bundled Archon skills into <targetPath>/.claude/skills/ (Claude Code)
 * and <targetPath>/.agents/skills/ (Codex):
 *   - `archon`     — the broad authoring/setup/run skill
 *   - `manage-run` — the focused run-management skill
 *
 * Pure file-system helper used by both the standalone `skill install` CLI
 * command and the interactive setup wizard.
 *
 * The `bundled-skill` module is dynamically imported here so that its top-level
 * `import … with { type: 'text' }` statements only execute when this function is
 * actually called. Compiled binaries (`bun build --compile`) still statically
 * analyze the literal-string `import()` and embed the chunk; linked-source
 * installs (`bun link`) don't touch the source skill files unless the user runs
 * `archon setup` or `archon skill install`. Without this indirection, every
 * `archon` invocation — including `archon --help` — fails at module load when
 * the source skill files are missing from disk.
 */
export async function copyArchonSkill(targetPath: string): Promise<void> {
  const { BUNDLED_SKILL_FILES, BUNDLED_MANAGE_RUN_SKILL_FILES } = await import('../bundled-skill');
  const skillsRoots = [
    join(targetPath, '.claude', 'skills'),
    join(targetPath, '.agents', 'skills'),
  ];

  for (const skillsRoot of skillsRoots) {
    writeSkillFiles(join(skillsRoot, 'archon'), BUNDLED_SKILL_FILES);
    writeSkillFiles(join(skillsRoot, 'manage-run'), BUNDLED_MANAGE_RUN_SKILL_FILES);
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

  try {
    const { BUNDLED_SKILL_FILES, BUNDLED_MANAGE_RUN_SKILL_FILES } =
      await import('../bundled-skill');
    const fileCount =
      Object.keys(BUNDLED_SKILL_FILES).length + Object.keys(BUNDLED_MANAGE_RUN_SKILL_FILES).length;
    const installTargets = [
      join(absoluteTarget, '.claude', 'skills'),
      join(absoluteTarget, '.agents', 'skills'),
    ];
    console.log(
      `Installing Archon skills (archon + manage-run, ${fileCount} files per destination) into ${installTargets.join(' and ')}`
    );

    await copyArchonSkill(absoluteTarget);
    console.log('Done. Restart Claude Code or Codex to load the skills.');
    return 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.error(`Error: Failed to install skill: ${err.message}`);
    return 1;
  }
}
