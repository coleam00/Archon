/**
 * Read / create / update / delete a single skill.
 *
 * `writeSkillMd` writes through symlinks by default (Node's `writeFile` follows
 * symlinks unless O_NOFOLLOW is requested) — this is intentional and matches
 * the user's "edit through symlink, sync back to my local skills" expectation.
 */

import { mkdir, readFile, rm, stat, lstat, realpath, writeFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';
import { getSkillDir } from './discovery';
import { listSkillFiles } from './files';
import { derivePrefix, parseSkillMd, serializeSkillMd, validateSkillName } from './frontmatter';
import {
  SkillFrontmatterError,
  SkillNameError,
  type SkillDetail,
  type SkillSource,
  type SkillSummary,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('skills.read-write');
  return cachedLog;
}

const SKILL_FILE = 'SKILL.md';

async function buildSummary(
  name: string,
  source: SkillSource,
  cwd: string,
  description: string,
  parseError: string | null
): Promise<SkillSummary> {
  const dir = getSkillDir(name, source, cwd);
  const skillMd = join(dir, SKILL_FILE);
  const skillStat = await stat(skillMd);

  const dirLstat = await lstat(dir);
  const isSymlink = dirLstat.isSymbolicLink();
  let realPathValue: string | null = null;
  if (isSymlink) {
    try {
      realPathValue = await realpath(dir);
    } catch (err) {
      getLog().warn({ err, dir }, 'skills.realpath_failed');
    }
  }

  const [scriptsExists, refsExists, assetsExists] = await Promise.all([
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
    realPath: realPathValue,
    mtime: skillStat.mtime.toISOString(),
    hasScripts: scriptsExists,
    hasReferences: refsExists,
    hasAssets: assetsExists,
    prefix: derivePrefix(name),
    parseError,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Read a single skill, including parsed frontmatter, body, and a recursive
 * file listing. Throws if the skill or its SKILL.md does not exist.
 */
export async function readSkill(
  name: string,
  source: SkillSource,
  cwd: string
): Promise<SkillDetail> {
  validateSkillName(name);
  const dir = getSkillDir(name, source, cwd);
  const skillMd = join(dir, SKILL_FILE);

  const content = await readFile(skillMd, 'utf8');
  let frontmatter: Record<string, unknown> = {};
  let body = '';
  let parseError: string | null = null;
  try {
    const parsed = parseSkillMd(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (err) {
    parseError = err instanceof SkillFrontmatterError ? err.message : (err as Error).message;
    body = content; // fall back so the user can still see / fix it in the editor
  }

  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const summary = await buildSummary(name, source, cwd, description, parseError);
  const files = await listSkillFiles(name, source, cwd);

  return { ...summary, frontmatter, body, files };
}

/**
 * Overwrite SKILL.md for an existing skill. Validates that
 * `frontmatter.name === name` (the directory name is the canonical id and
 * must not drift). Symlinks are followed transparently by `writeFile`.
 */
export async function writeSkillMd(
  name: string,
  source: SkillSource,
  cwd: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<SkillDetail> {
  validateSkillName(name);
  const dir = getSkillDir(name, source, cwd);
  const skillMd = join(dir, SKILL_FILE);

  if (!(await pathExists(skillMd))) {
    throw new Error(`Skill not found: ${source}/${name}`);
  }

  const fmName = frontmatter.name;
  if (typeof fmName !== 'string' || fmName !== name) {
    throw new SkillNameError(
      `frontmatter.name must equal the directory name '${name}' (got '${String(fmName)}')`
    );
  }
  const desc = frontmatter.description;
  if (typeof desc !== 'string' || desc.trim() === '') {
    throw new SkillFrontmatterError('frontmatter.description is required and must be non-empty');
  }
  if (desc.length > 1024) {
    throw new SkillFrontmatterError('frontmatter.description must be 1024 characters or fewer');
  }

  const serialized = serializeSkillMd(frontmatter, body);
  await writeFile(skillMd, serialized, 'utf8');

  return readSkill(name, source, cwd);
}

/**
 * Create a new skill directory with a fresh SKILL.md. Fails if the directory
 * already exists.
 */
export async function createSkill(
  name: string,
  source: SkillSource,
  cwd: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<SkillDetail> {
  validateSkillName(name);
  const dir = getSkillDir(name, source, cwd);

  if (await pathExists(dir)) {
    throw new Error(`Skill '${name}' already exists at ${dir}`);
  }

  const desc = frontmatter.description;
  if (typeof desc !== 'string' || desc.trim() === '') {
    throw new SkillFrontmatterError('frontmatter.description is required and must be non-empty');
  }
  if (desc.length > 1024) {
    throw new SkillFrontmatterError('frontmatter.description must be 1024 characters or fewer');
  }

  // Force frontmatter.name = directory name to keep them in sync.
  const finalFrontmatter = { ...frontmatter, name };
  const serialized = serializeSkillMd(finalFrontmatter, body);

  await mkdir(dir, { recursive: false });
  await writeFile(join(dir, SKILL_FILE), serialized, 'utf8');

  return readSkill(name, source, cwd);
}

/**
 * Delete a skill directory and everything in it. Destructive — callers must
 * confirm with the user. If the skill is symlinked, only the link is removed
 * (the target stays intact) — `rm` does not follow directory symlinks.
 */
export async function deleteSkill(name: string, source: SkillSource, cwd: string): Promise<void> {
  validateSkillName(name);
  const dir = getSkillDir(name, source, cwd);

  // For symlinks, `rm` removes the link but leaves the target. That's the
  // safe behavior — refuse via `unlink`-like semantics. For real directories,
  // recursive removal is intentional.
  const lst = await lstat(dir);
  if (lst.isSymbolicLink()) {
    await rm(dir, { recursive: false, force: false });
  } else {
    await rm(dir, { recursive: true, force: false });
  }
}
