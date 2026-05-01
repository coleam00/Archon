/**
 * Minimal agent-file reader used by the workflows engine to resolve
 * `agent_ref:` at execution time. Lives here (rather than in @archon/core)
 * because @archon/workflows depends on @archon/providers but not on
 * @archon/core, while @archon/core/agents (the rich registry CRUD) cannot
 * be imported from @archon/workflows without creating a dep cycle.
 *
 * Keep this file small and authoritative: parse frontmatter + body, return
 * a typed view. The Web UI and the REST API use the richer
 * `@archon/core/agents` package which depends on this one's discovery rules
 * by convention only (search paths, file format).
 */

import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export interface ResolvedAgent {
  name: string;
  description: string;
  model: string | null;
  tools: string[] | null;
  disallowedTools: string[] | null;
  mcp: string | null;
  skills: string[] | null;
  systemPrompt: string;
  /** Where the file was found. */
  source: 'project' | 'global';
  /** Absolute path to the file. */
  path: string;
}

function getHome(): string {
  return process.env.HOME ?? homedir();
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

interface ParsedMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Tiny YAML-frontmatter parser. Throws on malformed input. */
function parseAgentMdInline(content: string): ParsedMd {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && normalized !== '---' && !normalized.startsWith('---\r')) {
    throw new Error('agent file must begin with `---` frontmatter delimiter');
  }
  const afterOpen = normalized.slice(4);
  let yamlText: string;
  let body: string;
  if (afterOpen.startsWith('---\n') || afterOpen === '---' || afterOpen.startsWith('---\r')) {
    yamlText = '';
    const m = /^---\r?\n?/.exec(afterOpen);
    body = afterOpen.slice(m?.[0].length ?? 3);
  } else {
    const close = /\n---(?:\n|$)/.exec(afterOpen);
    if (!close) throw new Error('agent frontmatter is not closed');
    yamlText = afterOpen.slice(0, close.index);
    body = afterOpen.slice(close.index + close[0].length);
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlText);
  } catch (e) {
    throw new Error(`agent frontmatter contains invalid YAML: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return { frontmatter: {}, body };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent frontmatter must be a YAML object');
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function coerceStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const filtered = raw.filter((x): x is string => typeof x === 'string');
  return filtered.length > 0 ? filtered : null;
}

function coerceString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Resolve an agent by name against `<cwd>/.claude/agents/` (project, preferred)
 * and `~/.claude/agents/` (global, fallback). Returns null if the agent does
 * not exist. Throws if the file exists but cannot be parsed.
 */
export async function loadAgentFile(name: string, cwd: string): Promise<ResolvedAgent | null> {
  const candidates: { path: string; source: 'project' | 'global' }[] = [
    { path: join(cwd, '.claude', 'agents', `${name}.md`), source: 'project' },
    { path: join(getHome(), '.claude', 'agents', `${name}.md`), source: 'global' },
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.path))) continue;
    const content = await readFile(candidate.path, 'utf8');
    const { frontmatter, body } = parseAgentMdInline(content);
    const description = coerceString(frontmatter.description) ?? '';
    return {
      name,
      description,
      model: coerceString(frontmatter.model),
      tools: coerceStringArray(frontmatter.tools),
      disallowedTools: coerceStringArray(frontmatter.disallowedTools),
      mcp: coerceString(frontmatter.mcp),
      skills: coerceStringArray(frontmatter.skills),
      systemPrompt: body.trim(),
      source: candidate.source,
      path: candidate.path,
    };
  }
  return null;
}
