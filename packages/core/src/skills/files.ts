/**
 * File operations inside a skill directory.
 *
 * Used by the file-tree editor in the Web UI to view, create, edit, and delete
 * arbitrary supporting files (`scripts/`, `references/`, `assets/`, ...).
 *
 * SECURITY: every relative path is validated to remain inside the skill
 * directory after resolution. `..` traversal, absolute paths, and any
 * post-resolution escape are rejected. SKILL.md is treated specially — it must
 * not be deleted via the file API; that goes through `deleteSkill`.
 */

import { readdir, readFile, rm, stat, lstat, mkdir, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { getSkillDir } from './discovery';
import { SkillPathTraversalError } from './types';
import type { SkillFileNode, SkillSource } from './types';

const SKILL_FILE = 'SKILL.md';
const MAX_DEPTH = 4;

/**
 * Resolve `relPath` against `skillDir` and verify the result stays inside.
 * Rejects empty paths, `..` segments, absolute paths, and any path that
 * escapes after resolution (handles `foo/../../etc` and similar).
 */
export function resolveSafeFilePath(skillDir: string, relPath: string): string {
  if (!relPath || typeof relPath !== 'string') {
    throw new SkillPathTraversalError('File path is required');
  }
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new SkillPathTraversalError(`Absolute paths are not allowed: ${relPath}`);
  }

  const resolvedSkillDir = resolve(skillDir);
  const candidate = resolve(resolvedSkillDir, relPath);
  const rel = relative(resolvedSkillDir, candidate);

  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new SkillPathTraversalError(`Path '${relPath}' escapes the skill directory`);
  }
  return candidate;
}

/** List files under a skill directory recursively (depth ≤ MAX_DEPTH). */
export async function listSkillFiles(
  name: string,
  source: SkillSource,
  cwd: string
): Promise<SkillFileNode[]> {
  const skillDir = getSkillDir(name, source, cwd);
  const out: SkillFileNode[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(skillDir, abs).split(sep).join('/');

      const lst = await lstat(abs);
      const node: SkillFileNode = {
        path: rel,
        isDirectory: entry.isDirectory(),
        isSymlink: lst.isSymbolicLink(),
      };
      if (!node.isDirectory) {
        const st = await stat(abs);
        node.size = st.size;
      }
      out.push(node);

      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
      }
    }
  }

  await walk(skillDir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read a file inside a skill directory. Returns the raw bytes plus a guessed
 * MIME type. Callers can decide whether to interpret as UTF-8 or send as a
 * binary stream.
 */
export async function readSkillFile(
  name: string,
  source: SkillSource,
  cwd: string,
  relPath: string
): Promise<{ bytes: Uint8Array; mime: string; size: number }> {
  const skillDir = getSkillDir(name, source, cwd);
  const abs = resolveSafeFilePath(skillDir, relPath);
  const buf = await readFile(abs);
  return {
    bytes: new Uint8Array(buf),
    mime: guessMime(relPath),
    size: buf.byteLength,
  };
}

/** Write or overwrite a file inside a skill directory. Creates parent dirs. */
export async function writeSkillFile(
  name: string,
  source: SkillSource,
  cwd: string,
  relPath: string,
  content: Uint8Array | string
): Promise<void> {
  const skillDir = getSkillDir(name, source, cwd);
  const abs = resolveSafeFilePath(skillDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  if (typeof content === 'string') {
    await writeFile(abs, content, 'utf8');
  } else {
    await writeFile(abs, content);
  }
}

/**
 * Delete a file inside a skill directory. Refuses to delete SKILL.md — that
 * goes through `deleteSkill` (which removes the whole directory).
 */
export async function deleteSkillFile(
  name: string,
  source: SkillSource,
  cwd: string,
  relPath: string
): Promise<void> {
  if (relPath === SKILL_FILE) {
    throw new SkillPathTraversalError(
      'Cannot delete SKILL.md via the file API — delete the skill instead'
    );
  }
  const skillDir = getSkillDir(name, source, cwd);
  const abs = resolveSafeFilePath(skillDir, relPath);
  await rm(abs, { recursive: true, force: false });
}

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function guessMime(relPath: string): string {
  const idx = relPath.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  const ext = relPath.slice(idx).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
