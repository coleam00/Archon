/**
 * Agent discovery — walks `~/.claude/agents/` (global) and `<cwd>/.claude/agents/`
 * (project) to produce a deduplicated list of `AgentSummary` records.
 *
 * Project entries override global entries by name, matching Claude Code's
 * native subagent precedence. Malformed agent files are captured as
 * `AgentSummary.parseError` so the UI can surface them — one bad file does not
 * abort discovery.
 *
 * Files starting with `_` (e.g. `_templates/`) are silently ignored — those
 * are reserved for archon's own scaffold storage.
 */

import { lstat, readdir, readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '@archon/paths';
import { coerceModel, coerceStatus, coerceStringArray, parseAgentMd } from './frontmatter';
import {
  AgentFrontmatterError,
  type AgentDiscoveryResult,
  type AgentLoadError,
  type AgentSource,
  type AgentSummary,
} from './types';

/**
 * Resolve the user's home directory. Prefers `$HOME` so tests that override
 * `process.env.HOME` work — Bun caches `os.homedir()` after first call.
 */
function getHome(): string {
  return process.env.HOME ?? homedir();
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('agents.discovery');
  return cachedLog;
}

/** Returns `<cwd>/.claude/agents` and `~/.claude/agents` (in that order). */
export function getAgentsSearchPaths(cwd: string): { dir: string; source: AgentSource }[] {
  return [
    { dir: join(cwd, '.claude', 'agents'), source: 'project' },
    { dir: join(getHome(), '.claude', 'agents'), source: 'global' },
  ];
}

/** Resolve the absolute path for a single agent file. */
export function getAgentPath(name: string, source: AgentSource, cwd: string): string {
  const dir =
    source === 'project' ? join(cwd, '.claude', 'agents') : join(getHome(), '.claude', 'agents');
  return join(dir, `${name}.md`);
}

async function loadOneAgent(
  filePath: string,
  name: string,
  source: AgentSource
): Promise<AgentSummary | { error: AgentLoadError }> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: { name, source, path: filePath, error: 'agent file not found' } };
    }
    throw err;
  }
  if (!fileStat.isFile()) {
    return { error: { name, source, path: filePath, error: 'agent path is not a regular file' } };
  }

  const fileLstat = await lstat(filePath);
  const isSymlink = fileLstat.isSymbolicLink();
  let realPath: string | null = null;
  if (isSymlink) {
    try {
      realPath = await realpath(filePath);
    } catch (err) {
      getLog().warn({ err, filePath }, 'agents.realpath_failed');
    }
  }

  let frontmatter: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = parseAgentMd(content);
    frontmatter = parsed.frontmatter;
  } catch (err) {
    parseError = err instanceof AgentFrontmatterError ? err.message : (err as Error).message;
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
    realPath,
    mtime: fileStat.mtime.toISOString(),
    status: coerceStatus(frontmatter.status),
    model: coerceModel(frontmatter.model),
    skillCount: skills.length,
    toolCount: tools.length,
    parseError,
  };
}

async function discoverInDir(
  dir: string,
  source: AgentSource
): Promise<{
  summaries: Map<string, AgentSummary>;
  errors: AgentLoadError[];
}> {
  const summaries = new Map<string, AgentSummary>();
  const errors: AgentLoadError[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { summaries, errors };
    }
    getLog().warn({ err, dir }, 'agents.readdir_failed');
    return { summaries, errors };
  }

  for (const entry of entries) {
    // Only consider regular files or symlinks.
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith('.md')) continue;
    // Reserved prefix: `_templates/` etc.
    if (entry.name.startsWith('_')) continue;
    // Hidden files.
    if (entry.name.startsWith('.')) continue;

    const name = entry.name.slice(0, -'.md'.length);
    const filePath = join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      try {
        const targetStat = await stat(filePath);
        if (!targetStat.isFile()) continue;
      } catch (err) {
        getLog().warn({ err, filePath }, 'agents.broken_symlink');
        continue;
      }
    }

    const result = await loadOneAgent(filePath, name, source);
    if ('error' in result) {
      errors.push(result.error);
      continue;
    }
    summaries.set(name, result);
  }

  return { summaries, errors };
}

/**
 * Discover all agents visible from `cwd`. Project entries override global by name.
 *
 * Errors during walking are returned alongside the result rather than thrown
 * so the UI can surface partial results.
 */
export async function discoverAgents(cwd: string): Promise<AgentDiscoveryResult> {
  const errors: AgentLoadError[] = [];
  const merged = new Map<string, AgentSummary>();

  const [projectResult, globalResult] = await Promise.all([
    discoverInDir(join(cwd, '.claude', 'agents'), 'project'),
    discoverInDir(join(getHome(), '.claude', 'agents'), 'global'),
  ]);

  for (const summary of globalResult.summaries.values()) {
    merged.set(summary.name, summary);
  }
  for (const summary of projectResult.summaries.values()) {
    merged.set(summary.name, summary);
  }
  errors.push(...globalResult.errors, ...projectResult.errors);

  const agents = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { agents, errors };
}
