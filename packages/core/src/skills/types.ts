/**
 * Skill types — Claude Agent SDK skill registry.
 *
 * A skill is a directory `<name>/` containing at least a `SKILL.md` file
 * with YAML frontmatter (`name`, `description` required) and a markdown body.
 * Optional sibling files: `scripts/`, `references/`, `assets/`.
 *
 * Skills live in two locations the Claude SDK already reads:
 *   - `~/.claude/skills/<name>/`           (source: 'global')
 *   - `<cwd>/.claude/skills/<name>/`       (source: 'project')
 *
 * Project entries override global entries by name.
 */

export type SkillSource = 'global' | 'project';

export interface SkillSummary {
  name: string;
  /** First 200 chars of frontmatter.description (full text shipped in SkillDetail). */
  description: string;
  source: SkillSource;
  /** Absolute directory path as seen on disk (the symlink itself if symlinked). */
  path: string;
  isSymlink: boolean;
  /** Resolved target if `isSymlink` is true; otherwise null. */
  realPath: string | null;
  /** ISO 8601 mtime of SKILL.md. */
  mtime: string;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  /**
   * Auto-derived prefix used as a soft category in the UI.
   * Examples: "atw-review" → "atw", "claude-api:pdf" → "claude-api",
   * "gws-gmail" → "gws". `null` when no separator is present.
   */
  prefix: string | null;
  /** Non-null when SKILL.md exists but its frontmatter is malformed. */
  parseError: string | null;
}

export interface SkillDetail extends SkillSummary {
  /** Parsed frontmatter object (raw — preserves unknown keys). */
  frontmatter: Record<string, unknown>;
  /** Markdown body of SKILL.md (everything after the closing `---`). */
  body: string;
  /** Recursive listing of supporting files in the skill directory. */
  files: SkillFileNode[];
}

export interface SkillFileNode {
  /** Path relative to the skill directory (POSIX separators). */
  path: string;
  isDirectory: boolean;
  /** Bytes — undefined for directories. */
  size?: number;
  isSymlink?: boolean;
}

export interface SkillLoadError {
  name: string;
  source: SkillSource;
  path: string;
  error: string;
}

export interface SkillDiscoveryResult {
  skills: SkillSummary[];
  errors: SkillLoadError[];
}

/** Thrown when SKILL.md frontmatter is malformed (missing close, invalid YAML, etc.). */
export class SkillFrontmatterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SkillFrontmatterError';
  }
}

/** Thrown by validateSkillName. */
export class SkillNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillNameError';
  }
}

/** Thrown when a relative file path escapes the skill directory. */
export class SkillPathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPathTraversalError';
  }
}
