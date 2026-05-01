/**
 * Read / create / update / delete a single agent file.
 *
 * Agents are single `.md` files at `.claude/agents/<name>.md` (project) or
 * `~/.claude/agents/<name>.md` (global). Symlinks are followed transparently
 * by `writeFile` — that matches "edit-through-symlink" expectations and
 * mirrors the skills package's behavior.
 */

import { mkdir, readFile, rm, stat, lstat, realpath, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { createLogger } from '@archon/paths';
import { getAgentPath } from './discovery';
import {
  coerceModel,
  coerceStatus,
  coerceStringArray,
  parseAgentMd,
  serializeAgentMd,
  validateAgentName,
} from './frontmatter';
import {
  AgentFrontmatterError,
  AgentNameError,
  type AgentDetail,
  type AgentSource,
  type AgentSummary,
} from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agents.read-write');
  return cachedLog;
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

async function buildSummary(
  name: string,
  source: AgentSource,
  cwd: string,
  frontmatter: Record<string, unknown>,
  parseError: string | null
): Promise<AgentSummary> {
  const filePath = getAgentPath(name, source, cwd);
  const fileStat = await stat(filePath);

  const fileLstat = await lstat(filePath);
  const isSymlink = fileLstat.isSymbolicLink();
  let realPathValue: string | null = null;
  if (isSymlink) {
    try {
      realPathValue = await realpath(filePath);
    } catch (err) {
      getLog().warn({ err, filePath }, 'agents.realpath_failed');
    }
  }

  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const skills = coerceStringArray(frontmatter.skills);
  const tools = coerceStringArray(frontmatter.tools);

  return {
    name,
    description: description.slice(0, 200),
    source,
    path: filePath,
    isSymlink,
    realPath: realPathValue,
    mtime: fileStat.mtime.toISOString(),
    status: coerceStatus(frontmatter.status),
    model: coerceModel(frontmatter.model),
    skillCount: skills.length,
    toolCount: tools.length,
    parseError,
  };
}

/**
 * Read a single agent. Throws if the file does not exist. Returns a partial
 * `AgentDetail` with `parseError` set when frontmatter is malformed — the
 * full file content is shipped as `body` so the editor can still surface it.
 */
export async function readAgent(
  name: string,
  source: AgentSource,
  cwd: string
): Promise<AgentDetail> {
  validateAgentName(name);
  const filePath = getAgentPath(name, source, cwd);

  const content = await readFile(filePath, 'utf8');
  let frontmatter: Record<string, unknown> = {};
  let body = '';
  let parseError: string | null = null;
  try {
    const parsed = parseAgentMd(content);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (err) {
    parseError = err instanceof AgentFrontmatterError ? err.message : (err as Error).message;
    body = content;
  }

  const summary = await buildSummary(name, source, cwd, frontmatter, parseError);
  return { ...summary, frontmatter, body };
}

/**
 * Validate frontmatter shape before write. Errors are AgentFrontmatterError
 * (missing/invalid fields) or AgentNameError (name drift from filename).
 */
function assertWritableFrontmatter(name: string, frontmatter: Record<string, unknown>): void {
  const fmName = frontmatter.name;
  if (typeof fmName !== 'string' || fmName !== name) {
    throw new AgentNameError(
      `frontmatter.name must equal the file name '${name}' (got '${String(fmName)}')`
    );
  }
  const desc = frontmatter.description;
  if (typeof desc !== 'string' || desc.trim() === '') {
    throw new AgentFrontmatterError('frontmatter.description is required and must be non-empty');
  }
  if (desc.length > 1024) {
    throw new AgentFrontmatterError('frontmatter.description must be 1024 characters or fewer');
  }
}

/**
 * Overwrite an existing agent file. Validates that frontmatter.name matches
 * the filename (the filename is the canonical id and must not drift).
 */
export async function writeAgent(
  name: string,
  source: AgentSource,
  cwd: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<AgentDetail> {
  validateAgentName(name);
  const filePath = getAgentPath(name, source, cwd);

  if (!(await pathExists(filePath))) {
    throw new Error(`Agent not found: ${source}/${name}`);
  }

  assertWritableFrontmatter(name, frontmatter);

  const serialized = serializeAgentMd(frontmatter, body);
  await writeFile(filePath, serialized, 'utf8');

  return readAgent(name, source, cwd);
}

/** Create a new agent file. Fails if it already exists. */
export async function createAgent(
  name: string,
  source: AgentSource,
  cwd: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<AgentDetail> {
  validateAgentName(name);
  const filePath = getAgentPath(name, source, cwd);

  if (await pathExists(filePath)) {
    throw new Error(`Agent '${name}' already exists at ${filePath}`);
  }

  // Force frontmatter.name = filename to keep them in sync. Body and the rest
  // of the frontmatter remain caller-controlled.
  const finalFrontmatter = { ...frontmatter, name };
  assertWritableFrontmatter(name, finalFrontmatter);

  const serialized = serializeAgentMd(finalFrontmatter, body);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, serialized, 'utf8');

  return readAgent(name, source, cwd);
}

/** Delete an agent file. Symlinks: only the link is removed, not the target. */
export async function deleteAgent(name: string, source: AgentSource, cwd: string): Promise<void> {
  validateAgentName(name);
  const filePath = getAgentPath(name, source, cwd);
  await rm(filePath, { force: false });
}
