/**
 * Agent file frontmatter parsing and serialization.
 *
 * Format (matches Claude Code's native subagent format):
 *   ---
 *   name: code-reviewer
 *   description: Reviews code for bugs and style issues.
 *   model: sonnet
 *   tools: [Read, Grep, Glob]
 *   ---
 *
 *   You are an expert code reviewer.
 *   ...
 *
 * Round-trips unknown keys so frontmatter written by other tools survives an
 * archon edit cycle.
 */

import { AgentFrontmatterError, AgentNameError, type AgentStatus } from './types';

const RESERVED_NAMES = new Set(['anthropic', 'claude']);
const NAME_RE = /^[a-z0-9-]{1,64}$/;

export interface ParsedAgentMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse an agent .md file. Throws AgentFrontmatterError on:
 *   - missing opening `---`
 *   - missing closing `---`
 *   - YAML parse failure
 *   - frontmatter that is not an object
 */
export function parseAgentMd(content: string): ParsedAgentMd {
  const normalized = content.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n') && normalized !== '---' && !normalized.startsWith('---\r')) {
    throw new AgentFrontmatterError(
      'Agent file must begin with a YAML frontmatter block delimited by `---`'
    );
  }

  const afterOpen = normalized.slice(4);

  let yamlText: string;
  let body: string;
  if (afterOpen.startsWith('---\n') || afterOpen === '---' || afterOpen.startsWith('---\r')) {
    yamlText = '';
    const trailingMatch = /^---\r?\n?/.exec(afterOpen);
    body = afterOpen.slice(trailingMatch?.[0].length ?? 3);
  } else {
    const closeRegex = /\n---(?:\n|$)/;
    const match = closeRegex.exec(afterOpen);
    if (!match) {
      throw new AgentFrontmatterError(
        'Agent frontmatter is not closed — expected a `---` line after the YAML block'
      );
    }
    yamlText = afterOpen.slice(0, match.index);
    body = afterOpen.slice(match.index + match[0].length);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlText);
  } catch (err) {
    throw new AgentFrontmatterError(
      `Agent frontmatter contains invalid YAML: ${(err as Error).message}`,
      err
    );
  }

  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentFrontmatterError('Agent frontmatter must be a YAML object');
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

/**
 * Serialize frontmatter + body back to a `<name>.md` string. Key order is
 * stabilized for diff stability: name, description, model, status, tools,
 * disallowedTools, mcp, skills, identity, then the rest alphabetically.
 *
 * Always ends in a single trailing newline.
 */
export function serializeAgentMd(frontmatter: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {};
  const PREFERRED_KEYS = [
    'name',
    'description',
    'model',
    'status',
    'tools',
    'disallowedTools',
    'mcp',
    'skills',
    'max_turns',
    'effort',
    'thinking',
    'identity',
  ];
  for (const key of PREFERRED_KEYS) {
    if (key in frontmatter) ordered[key] = frontmatter[key];
  }
  const remaining = Object.keys(frontmatter)
    .filter(k => !PREFERRED_KEYS.includes(k))
    .sort();
  for (const key of remaining) {
    ordered[key] = frontmatter[key];
  }

  const yamlText = Bun.YAML.stringify(ordered, null, 2).trimEnd();
  const trimmedBody = body.replace(/^\n+/, '').replace(/\n*$/, '\n');

  return `---\n${yamlText}\n---\n\n${trimmedBody}`;
}

/**
 * Validate an agent name:
 *   - 1–64 characters
 *   - lowercase letters, digits, hyphens only
 *   - reserved words "anthropic" and "claude" are forbidden
 *   - reserved word "_templates" is forbidden (used for the scaffold dir)
 *
 * Throws AgentNameError on failure.
 */
export function validateAgentName(name: string): void {
  if (typeof name !== 'string') {
    throw new AgentNameError('Agent name is required');
  }
  if (name.startsWith('_')) {
    throw new AgentNameError(`Invalid agent name '${name}': names beginning with '_' are reserved`);
  }
  if (!NAME_RE.test(name)) {
    throw new AgentNameError(
      `Invalid agent name '${name}': must be 1-64 characters of lowercase letters, digits, or hyphens`
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new AgentNameError(`Agent name '${name}' is reserved and cannot be used`);
  }
}

/** Coerce frontmatter.status into a valid AgentStatus, defaulting to 'active'. */
export function coerceStatus(raw: unknown): AgentStatus {
  if (raw === 'draft' || raw === 'archived') return raw;
  return 'active';
}

/** Coerce a string|null model field. */
export function coerceModel(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** Coerce a string[] field, returning [] for missing/invalid input. */
export function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}
