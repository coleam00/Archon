import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { CheckResult } from './doctor-check';

const RETIRED_SKILL_ROOTS = ['archon', 'manage-run'] as const;
const CURRENT_SKILL_ROOT = 'archon-cli';

type LoadBundledSkillFiles = () => Promise<Record<string, string>>;

const loadBundledSkillFiles: LoadBundledSkillFiles = async () =>
  (await import('../bundled-skill')).BUNDLED_SKILL_FILES;

function skillTreeMatches(skillRoot: string, bundledFiles: Record<string, string>): boolean {
  const unmatched = new Set(Object.keys(bundledFiles));
  const pending = [{ absolute: skillRoot, relative: '' }];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;

    for (const entry of readdirSync(directory.absolute, { withFileTypes: true })) {
      const absolute = join(directory.absolute, entry.name);
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
      } else if (
        !entry.isFile() ||
        !unmatched.delete(relative) ||
        readFileSync(absolute, 'utf-8') !== bundledFiles[relative]
      ) {
        return false;
      }
    }
  }

  return unmatched.size === 0;
}

interface SkillRootScan {
  retired: string[];
  installedRoots: string[];
  missingRoots: string[];
}

/** Sort each existing skills root by whether it holds retired roots and the current one. */
function scanSkillRoots(skillsRoots: string[]): SkillRootScan {
  const scan: SkillRootScan = { retired: [], installedRoots: [], missingRoots: [] };
  for (const skillsRoot of skillsRoots.filter(root => existsSync(root))) {
    for (const name of RETIRED_SKILL_ROOTS) {
      if (existsSync(join(skillsRoot, name))) scan.retired.push(`${skillsRoot}/${name}`);
    }
    const hasCurrent = existsSync(join(skillsRoot, CURRENT_SKILL_ROOT));
    (hasCurrent ? scan.installedRoots : scan.missingRoots).push(skillsRoot);
  }
  return scan;
}

/**
 * Catch the v0.10.0 skill migration that `archon skill add` performs but
 * upgrades never run: leftover `archon` / `manage-run` roots, or a missing
 * `archon-cli` replacement. Skip when this project has never installed skills.
 */
export async function checkArchonSkill(
  cwd: string = process.cwd(),
  loadFiles: LoadBundledSkillFiles = loadBundledSkillFiles
): Promise<CheckResult> {
  const label = 'Archon skill';
  const { retired, installedRoots, missingRoots } = scanSkillRoots([
    join(cwd, '.claude', 'skills'),
    join(cwd, '.agents', 'skills'),
  ]);

  if (retired.length > 0) {
    return {
      label,
      status: 'fail',
      message: `retired skill root(s) still present. Run \`archon skill add .\` to replace them with ${CURRENT_SKILL_ROOT}.`,
    };
  }

  if (missingRoots.length > 0) {
    return {
      label,
      status: 'fail',
      message: `${CURRENT_SKILL_ROOT} is missing from ${missingRoots.join(', ')}. Run \`archon skill add .\` to install the current skill in this project.`,
    };
  }

  if (installedRoots.length === 0) {
    return {
      label,
      status: 'skip',
      message: 'not installed (run `archon skill add .` if you use Claude Code or Codex skills)',
    };
  }

  const bundledFiles = await loadFiles();
  for (const skillsRoot of installedRoots) {
    const currentRoot = join(skillsRoot, CURRENT_SKILL_ROOT);
    if (!skillTreeMatches(currentRoot, bundledFiles)) {
      return {
        label,
        status: 'fail',
        message: `${currentRoot} differs from the skill bundled with this Archon build. Run \`archon skill add .\` to update it.`,
      };
    }
  }

  return { label, status: 'pass', message: `${CURRENT_SKILL_ROOT} installed` };
}
