/**
 * SKILL.md frontmatter parsing and serialization.
 *
 * Format (per agentskills.io):
 *   ---
 *   name: my-skill
 *   description: ...
 *   ---
 *
 *   # Markdown body
 *
 * No third-party dep — uses Bun.YAML for the YAML block and string ops for the
 * delimiters. Round-trips unknown keys (e.g. `argument-hint`, `allowed-tools`).
 */

import { SkillFrontmatterError, SkillNameError } from './types';

const RESERVED_NAMES = new Set(['anthropic', 'claude']);
const NAME_RE = /^[a-z0-9-]{1,64}$/;

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse a SKILL.md file. Throws SkillFrontmatterError on:
 *   - missing opening `---`
 *   - missing closing `---`
 *   - YAML parse failure
 *   - frontmatter that is not an object
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  // Normalize line endings — keep Windows files parseable.
  const normalized = content.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n') && normalized !== '---' && !normalized.startsWith('---\r')) {
    throw new SkillFrontmatterError(
      'SKILL.md must begin with a YAML frontmatter block delimited by `---`'
    );
  }

  // Skip the opening `---\n`
  const afterOpen = normalized.slice(4);

  let yamlText: string;
  let body: string;
  // Empty frontmatter: opening is immediately followed by another `---` line.
  if (afterOpen.startsWith('---\n') || afterOpen === '---' || afterOpen.startsWith('---\r')) {
    yamlText = '';
    const trailingMatch = /^---\r?\n?/.exec(afterOpen);
    body = afterOpen.slice(trailingMatch?.[0].length ?? 3);
  } else {
    // Find the closing `---` on its own line: `\n---\n` or trailing `\n---` at EOF.
    const closeRegex = /\n---(?:\n|$)/;
    const match = closeRegex.exec(afterOpen);
    if (!match) {
      throw new SkillFrontmatterError(
        'SKILL.md frontmatter is not closed — expected a `---` line after the YAML block'
      );
    }
    yamlText = afterOpen.slice(0, match.index);
    body = afterOpen.slice(match.index + match[0].length);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yamlText);
  } catch (err) {
    throw new SkillFrontmatterError(
      `SKILL.md frontmatter contains invalid YAML: ${(err as Error).message}`,
      err
    );
  }

  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillFrontmatterError('SKILL.md frontmatter must be a YAML object');
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

/**
 * Serialize frontmatter + body back to a SKILL.md string. Key order is
 * stabilized: `name`, `description`, then the rest alphabetically. Extra keys
 * are preserved verbatim.
 *
 * The body is always separated from the frontmatter by exactly one blank line
 * and the file ends with a single trailing newline.
 */
export function serializeSkillMd(frontmatter: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {};
  if ('name' in frontmatter) ordered.name = frontmatter.name;
  if ('description' in frontmatter) ordered.description = frontmatter.description;

  const remaining = Object.keys(frontmatter)
    .filter(k => k !== 'name' && k !== 'description')
    .sort();
  for (const key of remaining) {
    ordered[key] = frontmatter[key];
  }

  const yamlText = Bun.YAML.stringify(ordered, null, 2).trimEnd();
  const trimmedBody = body.replace(/^\n+/, '').replace(/\n*$/, '\n');

  return `---\n${yamlText}\n---\n\n${trimmedBody}`;
}

/**
 * Validate a skill name per Anthropic spec:
 *   - 1–64 characters
 *   - lowercase letters, digits, hyphens only
 *   - reserved words "anthropic" and "claude" are forbidden
 *
 * Throws SkillNameError on failure.
 */
export function validateSkillName(name: string): void {
  if (typeof name !== 'string') {
    throw new SkillNameError('Skill name is required');
  }
  if (!NAME_RE.test(name)) {
    throw new SkillNameError(
      `Invalid skill name '${name}': must be 1-64 characters of lowercase letters, digits, or hyphens`
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new SkillNameError(`Skill name '${name}' is reserved and cannot be used`);
  }
}

/**
 * Best-effort extraction of a category prefix from a skill name. Falls back to
 * `null` when no obvious separator is present.
 *
 *   "atw-review"      → "atw"
 *   "claude-api:pdf"  → "claude-api"
 *   "gws-gmail"       → "gws"
 *   "diagnose"        → null
 */
export function derivePrefix(name: string): string | null {
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0) return name.slice(0, colonIdx);

  const dashIdx = name.indexOf('-');
  if (dashIdx > 0 && dashIdx < name.length - 1) return name.slice(0, dashIdx);

  return null;
}
