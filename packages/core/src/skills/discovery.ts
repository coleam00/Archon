/**
 * Skill discovery — walks `~/.claude/skills/` (global) and `<cwd>/.claude/skills/`
 * (project) to produce a deduplicated list of `SkillSummary` records.
 *
 * Project entries override global entries by name (same precedence rule used
 * by Claude Code itself and by the existing workflow validator at
 * `packages/workflows/src/validator.ts`). Malformed SKILL.md files are
 * captured as `SkillSummary.parseError` so the UI can surface them — one bad
 * file does not abort discovery.
 */

import { lstat, readdir, readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '@archon/paths';
import { parseSkillMd, derivePrefix } from './frontmatter';

/**
 * Resolve the user's home directory. Prefers `$HOME` so tests that override
 * `process.env.HOME` work — Bun caches `os.homedir()` after first call.
 */
function getHome(): string {
  return process.env.HOME ?? homedir();
}
import type { SkillDiscoveryResult, SkillLoadError, SkillSource, SkillSummary } from './types';
import { SkillFrontmatterError } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('skills.discovery');
  return cachedLog;
}

const SKILL_FILE = 'SKILL.md';

/** Returns `<cwd>/.claude/skills` and `~/.claude/skills` (in that order). */
export function getSkillsSearchPaths(cwd: string): { dir: string; source: SkillSource }[] {
  return [
    { dir: join(cwd, '.claude', 'skills'), source: 'project' },
    { dir: join(getHome(), '.claude', 'skills'), source: 'global' },
  ];
}

/** Resolve the absolute directory for a single skill. */
export function getSkillDir(name: string, source: SkillSource, cwd: string): string {
  return source === 'project'
    ? join(cwd, '.claude', 'skills', name)
    : join(getHome(), '.claude', 'skills', name);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function loadOneSkill(
  dir: string,
  name: string,
  source: SkillSource
): Promise<SkillSummary | { error: SkillLoadError }> {
  const skillMd = join(dir, SKILL_FILE);
  let skillStat;
  try {
    skillStat = await stat(skillMd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory exists but has no SKILL.md — silently skip.
      return {
        error: {
          name,
          source,
          path: dir,
          error: 'SKILL.md not found',
        },
      };
    }
    throw err;
  }
  if (!skillStat.isFile()) {
    return {
      error: { name, source, path: dir, error: 'SKILL.md is not a regular file' },
    };
  }

  // Symlink detection: lstat the directory to see if the user pointed at one.
  const dirLstat = await lstat(dir);
  const isSymlink = dirLstat.isSymbolicLink();
  let realPath: string | null = null;
  if (isSymlink) {
    try {
      realPath = await realpath(dir);
    } catch (err) {
      getLog().warn({ err, dir }, 'skills.realpath_failed');
    }
  }

  // Parse frontmatter; capture errors instead of throwing.
  let description = '';
  let parseError: string | null = null;
  try {
    const content = await readFile(skillMd, 'utf8');
    const parsed = parseSkillMd(content);
    const desc = parsed.frontmatter.description;
    description = typeof desc === 'string' ? desc : '';
  } catch (err) {
    if (err instanceof SkillFrontmatterError) {
      parseError = err.message;
    } else {
      parseError = (err as Error).message;
    }
  }

  // Detect supporting subdirectories without descending into them.
  const [hasScripts, hasReferences, hasAssets] = await Promise.all([
    pathExists(join(dir, 'scripts')),
    pathExists(join(dir, 'references')),
    pathExists(join(dir, 'assets')),
  ]);

  return {
    name,
    description: description.slice(0, 200),
    source,
    path: dir,
    isSymlink,
    realPath,
    mtime: skillStat.mtime.toISOString(),
    hasScripts,
    hasReferences,
    hasAssets,
    prefix: derivePrefix(name),
    parseError,
  };
}

async function discoverInDir(
  dir: string,
  source: SkillSource
): Promise<{
  summaries: Map<string, SkillSummary>;
  errors: SkillLoadError[];
}> {
  const summaries = new Map<string, SkillSummary>();
  const errors: SkillLoadError[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { summaries, errors };
    }
    getLog().warn({ err, dir }, 'skills.readdir_failed');
    return { summaries, errors };
  }

  for (const entry of entries) {
    // Accept directories or symlinks (which may resolve to directories).
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;

    const skillDir = join(dir, entry.name);

    // For symlinks we still need stat() to verify the target is a directory.
    if (entry.isSymbolicLink()) {
      try {
        const targetStat = await stat(skillDir);
        if (!targetStat.isDirectory()) continue;
      } catch (err) {
        getLog().warn({ err, skillDir }, 'skills.broken_symlink');
        continue;
      }
    }

    const result = await loadOneSkill(skillDir, entry.name, source);
    if ('error' in result) {
      // SKILL.md missing — silently skip, only log at debug.
      getLog().debug({ ...result.error }, 'skills.skill_md_missing');
      continue;
    }
    summaries.set(entry.name, result);
  }

  return { summaries, errors };
}

/**
 * Discover all skills visible from `cwd`. Project entries override global by name.
 *
 * Errors during walking are returned alongside the result rather than thrown
 * so the UI can surface partial results.
 */
export async function discoverSkills(cwd: string): Promise<SkillDiscoveryResult> {
  const errors: SkillLoadError[] = [];
  const merged = new Map<string, SkillSummary>();

  // Lower precedence first.
  const [projectResult, globalResult] = await Promise.all([
    discoverInDir(join(cwd, '.claude', 'skills'), 'project'),
    discoverInDir(join(getHome(), '.claude', 'skills'), 'global'),
  ]);

  for (const summary of globalResult.summaries.values()) {
    merged.set(summary.name, summary);
  }
  for (const summary of projectResult.summaries.values()) {
    merged.set(summary.name, summary);
  }
  errors.push(...globalResult.errors, ...projectResult.errors);

  const skills = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}
