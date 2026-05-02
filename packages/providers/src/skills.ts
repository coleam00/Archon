import { access, readFile } from 'fs/promises';
import { constants } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { homedir } from 'os';

export interface SkillResolutionOptions {
  skillRoots?: string[];
  defaultRoots?: string[];
  allowPathRefs?: boolean;
}

export interface ResolvedSkill {
  ref: string;
  name: string;
  dirPath: string;
  skillPath: string;
}

export interface MissingSkill {
  ref: string;
  searchedPaths: string[];
  reason?: string;
}

export interface SkillResolutionResult {
  resolved: ResolvedSkill[];
  missing: MissingSkill[];
  searchRoots: string[];
}

export interface LoadedSkill extends ResolvedSkill {
  content: string;
}

type SkillCandidateStatus =
  | { status: 'readable'; path: string }
  | { status: 'missing'; path: string }
  | { status: 'unreadable'; path: string; code?: string; message: string };

function getHomeDir(): string {
  return process.env.HOME ?? homedir();
}

function expandRoot(root: string, cwd: string): string {
  const home = getHomeDir();
  if (root === '~') return home;
  if (root.startsWith(`~${sep}`)) return join(home, root.slice(2));
  return isAbsolute(root) ? root : resolve(cwd, root);
}

export function getDefaultSkillRoots(cwd: string): string[] {
  const home = getHomeDir();
  return [
    join(cwd, '.agents', 'skills'),
    join(cwd, '.codex', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.claude', 'skills'),
    '/etc/codex/skills',
  ];
}

export function getAgentSkillRoots(cwd: string): string[] {
  const home = getHomeDir();
  return [
    join(cwd, '.agents', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.claude', 'skills'),
  ];
}

export function getSkillSearchRoots(cwd: string, options: SkillResolutionOptions = {}): string[] {
  const roots = [
    ...(options.skillRoots ?? []).map(root => expandRoot(root, cwd)),
    ...(options.defaultRoots ?? getDefaultSkillRoots(cwd)),
  ];

  const seen = new Set<string>();
  return roots.filter(root => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

function looksLikePath(ref: string): boolean {
  return (
    isAbsolute(ref) ||
    ref.startsWith('.') ||
    ref.includes('/') ||
    ref.includes('\\') ||
    ref.endsWith('.md')
  );
}

async function checkSkillCandidate(path: string): Promise<SkillCandidateStatus> {
  try {
    await access(path, constants.R_OK);
    return { status: 'readable', path };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return { status: 'missing', path };
    }
    return { status: 'unreadable', path, code: err.code, message: err.message };
  }
}

function skillPathForRef(ref: string, cwd: string): { dirPath: string; skillPath: string } {
  const absolutePath = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const skillPath =
    basename(absolutePath) === 'SKILL.md' ? absolutePath : join(absolutePath, 'SKILL.md');
  const dirPath = basename(skillPath) === 'SKILL.md' ? dirname(skillPath) : absolutePath;
  return { dirPath, skillPath };
}

function skillNameFromPath(skillPath: string): string {
  return basename(dirname(skillPath));
}

function parseFrontmatterName(content: string): string | undefined {
  if (!content.startsWith('---\n')) return undefined;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return undefined;
  const frontmatter = content.slice(4, end);
  for (const line of frontmatter.split('\n')) {
    const match = /^name:\s*["']?([^"'\n]+)["']?\s*$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

export async function resolveSkillReferences(
  cwd: string,
  skillRefs: readonly string[] | undefined,
  options: SkillResolutionOptions = {}
): Promise<SkillResolutionResult> {
  const searchRoots = getSkillSearchRoots(cwd, options);
  const allowPathRefs = options.allowPathRefs ?? true;
  const resolved: ResolvedSkill[] = [];
  const missing: MissingSkill[] = [];
  const seenRefs = new Set<string>();
  const seenPaths = new Set<string>();

  for (const rawRef of skillRefs ?? []) {
    const ref = rawRef.trim();
    if (ref.length === 0 || seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    if (looksLikePath(ref)) {
      const candidate = skillPathForRef(ref, cwd);
      if (!allowPathRefs) {
        missing.push({
          ref,
          searchedPaths: [candidate.skillPath],
          reason: 'Path-based skill references are not supported by this provider',
        });
        continue;
      }

      const status = await checkSkillCandidate(candidate.skillPath);
      if (status.status === 'readable') {
        if (!seenPaths.has(candidate.skillPath)) {
          seenPaths.add(candidate.skillPath);
          resolved.push({
            ref,
            name: skillNameFromPath(candidate.skillPath),
            dirPath: candidate.dirPath,
            skillPath: candidate.skillPath,
          });
        }
      } else {
        missing.push({
          ref,
          searchedPaths: [candidate.skillPath],
          ...(status.status === 'unreadable'
            ? { reason: `Cannot read ${status.path}: ${status.message}` }
            : {}),
        });
      }
      continue;
    }

    const searchedPaths = searchRoots.map(root => join(root, ref, 'SKILL.md'));
    let skillPath: string | undefined;
    let failureReason: string | undefined;
    for (const candidate of searchedPaths) {
      const status = await checkSkillCandidate(candidate);
      if (status.status === 'readable') {
        skillPath = candidate;
        break;
      }
      if (status.status === 'unreadable') {
        failureReason = `Cannot read ${status.path}: ${status.message}`;
        break;
      }
    }

    if (skillPath) {
      const dirPath = dirname(skillPath);
      if (!seenPaths.has(skillPath)) {
        seenPaths.add(skillPath);
        resolved.push({ ref, name: ref, dirPath, skillPath });
      }
    } else {
      missing.push({ ref, searchedPaths, ...(failureReason ? { reason: failureReason } : {}) });
    }
  }

  return { resolved, missing, searchRoots };
}

export async function resolveProviderSkillReferences(
  provider: string | undefined,
  cwd: string,
  skillRefs: readonly string[] | undefined,
  options: SkillResolutionOptions = {}
): Promise<SkillResolutionResult> {
  if (provider === 'claude' || provider === 'pi') {
    return resolveSkillReferences(cwd, skillRefs, {
      defaultRoots: getAgentSkillRoots(cwd),
      allowPathRefs: false,
    });
  }

  return resolveSkillReferences(cwd, skillRefs, options);
}

export async function loadResolvedSkills(skills: readonly ResolvedSkill[]): Promise<LoadedSkill[]> {
  const loaded: LoadedSkill[] = [];
  for (const skill of skills) {
    const content = await readFile(skill.skillPath, 'utf-8');
    loaded.push({
      ...skill,
      name: parseFrontmatterName(content) ?? skill.name,
      content,
    });
  }
  return loaded;
}

export function formatMissingSkills(missing: readonly MissingSkill[]): string {
  return missing
    .map(skill => {
      const searched = skill.searchedPaths.map(path => `  - ${path}`).join('\n');
      const reason = skill.reason ? `${skill.reason}. ` : '';
      return `Skill '${skill.ref}' not found or not readable. ${reason}Searched:\n${searched}`;
    })
    .join('\n\n');
}
