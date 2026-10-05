import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

export interface ResolvedSkills {
  /** Absolute paths to resolved skill directories. Each contains a SKILL.md. */
  paths: string[];
  /** Skill names that couldn't be resolved in any search location. */
  missing: string[];
}

export interface ClaudeSkillSearchOptions {
  /** Effective Claude config directory. Defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  userConfigDir?: string;
  /** Whether Claude is configured to load project settings. */
  includeProject?: boolean;
  /** Container runs cannot see host user skills unless explicitly mounted. */
  includeUser?: boolean;
}

/** Claude Code's provider-native skill roots, in discovery precedence order. */
export function claudeSkillSearchRoots(
  cwd: string,
  options: ClaudeSkillSearchOptions = {}
): string[] {
  const home = process.env.HOME ?? homedir();
  const roots: string[] = [];
  if (options.includeProject !== false) {
    roots.push(join(cwd, '.claude', 'skills'));
  }
  if (options.includeUser !== false) {
    const userConfigDir =
      options.userConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
    roots.push(join(userConfigDir, 'skills'));
  }
  return roots;
}

/**
 * Cross-provider skill-discovery search order for a named skill. Pi and
 * Copilot use this compatibility resolver. Claude uses the narrower
 * `claudeSkillSearchRoots` contract because its CLI does not discover
 * `.agents/skills`.
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
export function skillSearchRoots(cwd: string): string[] {
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
  return resolveSkillDirectoriesFromRoots(skillSearchRoots(cwd), skillNames);
}

function resolveSkillDirectoriesFromRoots(
  roots: string[],
  skillNames: string[] | undefined
): ResolvedSkills {
  if (!skillNames || skillNames.length === 0) {
    return { paths: [], missing: [] };
  }

  const paths: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const rawName of skillNames) {
    if (typeof rawName !== 'string') continue;
    const name = rawName.trim();
    if (name.length === 0) continue;
    // Name-only contract: reject path traversal, nested paths, and absolute paths.
    if (isAbsolute(name) || basename(name) !== name || name === '.' || name === '..') {
      missing.push(rawName);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    let found: string | undefined;
    for (const root of roots) {
      const candidate = join(root, name);
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

/**
 * Names whose skill *directory* exists under any of `roots`, whether or not it
 * holds a loadable `SKILL.md`.
 *
 * This separates "installed, but not loadable from here" — a wrong path, a
 * disabled setting source, or a directory missing its SKILL.md, all of which are
 * actionable author errors — from "absent from disk entirely", which is the
 * normal state of Claude's built-in and `plugin:skill` entries. Shared by the
 * provider preflight and workflow validation so the two cannot disagree about
 * which case a declared name falls into.
 */
export function findInstalledSkillNames(roots: string[], skillNames: string[]): string[] {
  const installed: string[] = [];
  for (const rawName of skillNames) {
    if (typeof rawName !== 'string') continue;
    const name = rawName.trim();
    if (name.length === 0) continue;
    if (isAbsolute(name) || basename(name) !== name || name === '.' || name === '..') continue;
    if (roots.some(root => existsSync(join(root, name)))) installed.push(rawName);
  }
  return installed;
}

/**
 * Resolve skills only from locations Claude Code natively discovers.
 *
 * Claude does not discover the cross-provider `.agents/skills` convention.
 * Keep this separate from `resolveSkillDirectories`, which Pi and Copilot use
 * for their broader compatibility contract.
 */
export function resolveClaudeSkillDirectories(
  cwd: string,
  skillNames: string[] | undefined,
  options?: ClaudeSkillSearchOptions
): ResolvedSkills {
  return resolveSkillDirectoriesFromRoots(claudeSkillSearchRoots(cwd, options), skillNames);
}
