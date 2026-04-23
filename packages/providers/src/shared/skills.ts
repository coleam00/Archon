import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedSkills {
  /** Absolute paths to resolved skill directories. Each contains a SKILL.md. */
  paths: string[];
  /** Skill names that couldn't be resolved in any search location. */
  missing: string[];
}

/**
 * Skill-discovery search order for a named skill. Mirrors the locations
 * Claude's SDK and Pi's default resource loader both respect, so Archon
 * workflows that already work under Claude find the same skills under any
 * provider that calls this resolver.
 *
 * Order (first match wins per name):
 *   1. `<cwd>/.agents/skills/<name>/`     — project-local, agentskills.io standard
 *   2. `<cwd>/.claude/skills/<name>/`     — project-local, Claude convention
 *   3. `~/.agents/skills/<name>/`         — user-global, agentskills.io standard
 *   4. `~/.claude/skills/<name>/`         — user-global, Claude convention
 *
 * Ancestor traversal above cwd is deliberately not done — matches Pi's
 * cwd-bound scope and avoids ambiguity about which repo's skills win when
 * Archon runs out of a subdirectory.
 */
function skillSearchRoots(cwd: string): string[] {
  // Prefer `HOME` env var when set — Bun's os.homedir() bypasses `HOME` and
  // reads from the system uid lookup, which is correct in production but
  // makes tests using staged temp homes impossible.
  const home = process.env.HOME ?? homedir();
  return [
    join(cwd, '.agents', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
  ];
}

/**
 * Resolve Archon's name-based `skills:` nodeConfig references to absolute
 * directory paths. Each named skill is expected to be a directory containing
 * a `SKILL.md` file — the agentskills.io standard layout.
 *
 * Duplicate names are de-duped; empty/non-string entries are skipped.
 * Unresolved names are returned in `missing` for caller-side warning.
 */
export function resolveSkillDirectories(
  cwd: string,
  skillNames: string[] | undefined
): ResolvedSkills {
  if (!skillNames || skillNames.length === 0) {
    return { paths: [], missing: [] };
  }

  const roots = skillSearchRoots(cwd);
  const paths: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const rawName of skillNames) {
    if (typeof rawName !== 'string' || rawName.length === 0) continue;
    if (seen.has(rawName)) continue;
    seen.add(rawName);

    let found: string | undefined;
    for (const root of roots) {
      const candidate = join(root, rawName);
      if (existsSync(join(candidate, 'SKILL.md'))) {
        found = candidate;
        break;
      }
    }

    if (found) {
      paths.push(found);
    } else {
      missing.push(rawName);
    }
  }

  return { paths, missing };
}
