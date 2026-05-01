/**
 * Agent types — Claude Agent SDK agent registry.
 *
 * An agent is a single markdown file `<name>.md` with YAML frontmatter and a
 * markdown body. The body becomes the agent's system prompt; the frontmatter
 * configures identity, tool access, attached skills, and MCP servers.
 *
 * Agents live in two locations the Claude SDK already reads:
 *   - `~/.claude/agents/<name>.md`           (source: 'global')
 *   - `<cwd>/.claude/agents/<name>.md`       (source: 'project')
 *
 * Project entries override global entries by name. This matches Claude Code's
 * native subagent format so agents created via the registry are immediately
 * invokable from raw Claude Code sessions via the Task tool.
 */

export type AgentSource = 'global' | 'project';

/** Agent lifecycle status. Stored in frontmatter; defaults to 'active' when absent. */
export type AgentStatus = 'active' | 'draft' | 'archived';

export interface AgentSummary {
  name: string;
  /** First 200 chars of frontmatter.description. */
  description: string;
  source: AgentSource;
  /** Absolute path to the agent file (.md). */
  path: string;
  isSymlink: boolean;
  /** Resolved target if `isSymlink` is true; otherwise null. */
  realPath: string | null;
  /** ISO 8601 mtime of the agent file. */
  mtime: string;
  /** Lifecycle status from frontmatter, defaulting to 'active'. */
  status: AgentStatus;
  /** Model alias or full id, when set in frontmatter. */
  model: string | null;
  /** Number of skills attached, derived from frontmatter.skills. */
  skillCount: number;
  /** Number of tool entries, derived from frontmatter.tools. */
  toolCount: number;
  /** Non-null when the file exists but its frontmatter is malformed. */
  parseError: string | null;
}

export interface AgentDetail extends AgentSummary {
  /** Parsed frontmatter object — preserves unknown keys for round-trip. */
  frontmatter: Record<string, unknown>;
  /** Markdown body — everything after the closing `---`. The agent's system prompt. */
  body: string;
}

export interface AgentLoadError {
  name: string;
  source: AgentSource;
  path: string;
  error: string;
}

export interface AgentDiscoveryResult {
  agents: AgentSummary[];
  errors: AgentLoadError[];
}

/** Thrown when frontmatter is malformed (missing close, invalid YAML, etc.). */
export class AgentFrontmatterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AgentFrontmatterError';
  }
}

/** Thrown by validateAgentName. */
export class AgentNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentNameError';
  }
}
