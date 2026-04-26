/** Structured sections parsed from a workflow description. */
export interface ParsedDescription {
  whenToUse: string;
  triggers: string[];
  does: string;
  constraints: string;
  raw: string;
}

const SECTION_LABELS = [
  'Use when',
  '사용할 때',
  'Triggers',
  '트리거 예시',
  '트리거',
  'Does',
  '하는 일',
  'NOT for',
  'Constraints',
  '사용하지 않을 때',
  '제약',
  'Handles',
  '처리 범위',
  'Capability',
  '역량',
  'Input',
  '입력',
  'Note',
  '참고',
];

const SECTION_BOUNDARY = SECTION_LABELS.map(escapeRegExp).join('|');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readSection(text: string, labels: readonly string[]): string {
  return readSections(text, labels)[0] ?? '';
}

function readSections(text: string, labels: readonly string[]): string[] {
  const labelPattern = labels.map(escapeRegExp).join('|');
  const sectionRe = new RegExp(
    `(?:^|\\n)\\s*(?:${labelPattern}):\\s*(.+?)(?=\\n\\s*(?:${SECTION_BOUNDARY}):|\\n\\n|$)`,
    'gs'
  );
  return [...text.matchAll(sectionRe)].map(match => match[1].trim()).filter(Boolean);
}

/**
 * Parse a workflow `description` field into structured sections.
 *
 * Recognizes English labels ("Use when:", "Triggers:", "Does:", "NOT for:" /
 * "Constraints:") and their Korean defaults ("사용할 때:", "트리거 예시:",
 * "하는 일:", "사용하지 않을 때:"), plus less common variants like "Handles:",
 * "Capability:", and "Input:".
 *
 * Falls back gracefully — unparsed descriptions return empty sections with the
 * full text in `raw`.
 */
export function parseWorkflowDescription(description: string): ParsedDescription {
  const result: ParsedDescription = {
    whenToUse: '',
    triggers: [],
    does: '',
    constraints: '',
    raw: description,
  };

  if (!description) return result;

  // Normalize line breaks and collapse multi-line sections
  const text = description.replace(/\r\n/g, '\n');

  result.whenToUse = readSection(text, ['Use when', '사용할 때']);

  // Fallback: "Handles:" / "처리 범위:" (e.g., archon-assist)
  if (!result.whenToUse) {
    result.whenToUse = readSection(text, ['Handles', '처리 범위']);
  }

  // Extract triggers — parse quoted strings, fall back to comma-split
  const triggerText = readSection(text, ['Triggers', '트리거 예시', '트리거']);
  if (triggerText) {
    result.triggers = [...triggerText.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    // Fallback: comma-split for unquoted trigger lists
    if (result.triggers.length === 0) {
      result.triggers = triggerText
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0 && !t.includes('\n'));
    }
  }

  result.does = readSection(text, ['Does', '하는 일']);

  // Fallback: "Capability:" / "역량:" (e.g., archon-assist)
  if (!result.does) {
    result.does = readSection(text, ['Capability', '역량']);
  }

  result.constraints = readSections(text, [
    'NOT for',
    'Constraints',
    '사용하지 않을 때',
    '제약',
  ]).join('\n');

  return result;
}

/** Known acronyms to preserve in display names. */
const ACRONYMS = new Set(['pr', 'ci', 'dag', 'prd', 'api', 'ai']);

/**
 * Convert a workflow name to a display-friendly title.
 * Strips `archon-` prefix, converts kebab-case to Title Case,
 * preserves known acronyms (PR, CI, DAG, etc.).
 */
export function getWorkflowDisplayName(name: string): string {
  const stripped = name.replace(/^archon-/, '');
  return stripped
    .split('-')
    .map(word =>
      ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');
}

/** Workflow category for filtering. */
export type WorkflowCategory = 'All' | 'CI/CD' | 'Code Review' | 'Automation' | 'Development';

export const CATEGORIES: WorkflowCategory[] = [
  'All',
  'CI/CD',
  'Code Review',
  'Automation',
  'Development',
];

/**
 * Derive a category from the workflow name and description.
 * Uses word-boundary checks for short tokens to avoid false positives.
 */
export function getWorkflowCategory(name: string, description: string): WorkflowCategory {
  const lower = `${name} ${description}`.toLowerCase();

  // Code Review
  if (lower.includes('review')) {
    return 'Code Review';
  }

  // CI/CD — validation, testing (word-boundary for short tokens)
  if (lower.includes('validate') || lower.includes('test-loop') || /\bci\b/.test(lower)) {
    return 'CI/CD';
  }

  // Automation — issue creation, conflict resolution, refactoring
  if (
    lower.includes('create-issue') ||
    lower.includes('resolve-conflict') ||
    lower.includes('refactor') ||
    lower.includes('fix-github-issue') ||
    lower.includes('ralph')
  ) {
    return 'Automation';
  }

  // Development — feature, implement, plan, architect, assist
  if (
    lower.includes('feature') ||
    lower.includes('implement') ||
    lower.includes('plan') ||
    lower.includes('architect') ||
    lower.includes('assist') ||
    lower.includes('idea-to-pr') ||
    lower.includes('remotion')
  ) {
    return 'Development';
  }

  return 'Development';
}

/**
 * Derive tags from the workflow name and parsed description.
 */
export function getWorkflowTags(name: string, parsed: ParsedDescription): string[] {
  const tags: string[] = [];
  const text = `${name} ${parsed.raw}`.toLowerCase();

  if (text.includes('github') || text.includes('issue') || text.includes('pr')) tags.push('GitHub');
  if (text.includes('parallel') || text.includes('agent') || text.includes('ralph'))
    tags.push('Agent');
  if (text.includes('review')) tags.push('Review');
  if (text.includes('test') || text.includes('validation') || text.includes('validate'))
    tags.push('Testing');
  if (text.includes('refactor')) tags.push('Refactor');
  if (text.includes('conflict') || text.includes('merge')) tags.push('Git');
  if (text.includes('plan') || text.includes('prd') || text.includes('architect'))
    tags.push('Planning');

  // Deduplicate
  return [...new Set(tags)];
}

/** Map of icon name strings to use with dynamic icon lookup. */
export type WorkflowIconName =
  | 'Bug'
  | 'GitMerge'
  | 'Rocket'
  | 'RefreshCw'
  | 'TestTube'
  | 'Workflow'
  | 'Eye'
  | 'Lightbulb'
  | 'Wrench'
  | 'Zap'
  | 'Bot';

/**
 * Select an icon name based on workflow name and category.
 */
export function getWorkflowIconName(name: string, category: WorkflowCategory): WorkflowIconName {
  const lower = name.toLowerCase();

  if (lower.includes('issue') || lower.includes('bug') || lower.includes('fix')) return 'Bug';
  if (lower.includes('review')) return 'Eye';
  if (lower.includes('conflict') || lower.includes('merge')) return 'GitMerge';
  if (lower.includes('feature') || lower.includes('idea') || lower.includes('remotion'))
    return 'Rocket';
  if (lower.includes('refactor')) return 'RefreshCw';
  if (lower.includes('test') || lower.includes('validate')) return 'TestTube';
  if (lower.includes('plan') || lower.includes('prd') || lower.includes('architect'))
    return 'Lightbulb';
  if (lower.includes('ralph')) return 'Bot';
  if (lower.includes('assist')) return 'Wrench';

  // Fall back to category
  switch (category) {
    case 'Code Review':
      return 'Eye';
    case 'CI/CD':
      return 'TestTube';
    case 'Automation':
      return 'Zap';
    case 'Development':
      return 'Rocket';
    default:
      return 'Workflow';
  }
}
