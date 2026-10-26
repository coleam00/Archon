import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

export interface ResolvedSkills {
  /** Absolute paths to resolved skill directories. Each contains a SKILL.md. */
  paths: string[];
  /** Skill names that couldn't be resolved in any search location. */
  missing: string[];
}

/**
 * Cross-provider skill-discovery search order for a named skill. Pi and
 * Copilot use this compatibility resolver. A provider that declares its own
 * skill roots (Claude, whose CLI does not discover `.agents/skills`) resolves
 * against those instead.
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
    ...projectSkillSearchRoots(cwd),
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
  ];
}

/** The project-local half of {@link skillSearchRoots}. */
export function projectSkillSearchRoots(cwd: string): string[] {
  return [join(cwd, '.agents', 'skills'), join(cwd, '.claude', 'skills')];
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

/** Resolve skill names against `roots`, first match wins per name. */
export function resolveSkillDirectoriesFromRoots(
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
    if (!isSkillName(name)) {
      missing.push(rawName);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    const found = findSkillDirectory(roots, name);

    if (found) {
      paths.push(found);
    } else {
      missing.push(rawName);
    }
  }

  return { paths, missing };
}

function isSkillName(name: string): boolean {
  return !isAbsolute(name) && basename(name) === name && name !== '.' && name !== '..';
}

function findSkillDirectory(roots: string[], name: string): string | undefined {
  for (const root of roots) {
    const candidate = join(root, name);
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  return undefined;
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
    if (!isSkillName(name)) continue;
    if (roots.some(root => existsSync(join(root, name)))) installed.push(rawName);
  }
  return installed;
}

export const SETTING_SOURCES = ['project', 'user'] as const;

/**
 * Claude's effective setting sources when neither the node nor the install config
 * names any. Workflow validation and the Claude provider both read this, so the
 * skill roots validation checks are the ones a run actually loads.
 */
export const DEFAULT_SETTING_SOURCES: readonly (typeof SETTING_SOURCES)[number][] = [
  'project',
  'user',
];

/**
 * Normalize a raw `settingSources` value to the recognized entries, in order.
 * Undefined when raw is not an array.
 *
 * Workflow validation reads a provider's install-level default with this. It
 * keeps the per-entry semantics of the provider's own lenient config parse, so
 * validation and execution agree about a node's effective sources.
 *
 * Unrecognized entries are dropped rather than widening the result. Dropping
 * narrows, which is the safe direction; leaving the value unset would let a
 * single typo fall back to the permissive `['project','user']` default,
 * silently granting the ambient access the author was excluding.
 */
export function parseSettingSources(raw: unknown): (typeof SETTING_SOURCES)[number][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((entry): entry is (typeof SETTING_SOURCES)[number] =>
    SETTING_SOURCES.some(source => source === entry)
  );
}
