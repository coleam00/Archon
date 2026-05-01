/**
 * Pure helpers for the skill registry UI — formatting, derivations, and
 * filename heuristics that the components share.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/** "2 hours ago", "yesterday", "3 days ago", etc. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  if (diff < 30 * SECOND) return 'just now';
  if (diff < HOUR) return `${Math.round(diff / MINUTE).toString()} min ago`;
  if (diff < DAY) {
    const h = Math.round(diff / HOUR);
    return h === 1 ? '1 hour ago' : `${h.toString()} hours ago`;
  }
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < WEEK) return `${Math.round(diff / DAY).toString()} days ago`;
  if (diff < MONTH) {
    const w = Math.round(diff / WEEK);
    return w === 1 ? '1 week ago' : `${w.toString()} weeks ago`;
  }
  const months = Math.round(diff / MONTH);
  if (months < 12) return `${months.toString()} months ago`;
  const years = Math.round(months / 12);
  return years === 1 ? '1 year ago' : `${years.toString()} years ago`;
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.py',
  '.sh',
  '.bash',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.html',
  '.css',
  '.toml',
  '.csv',
  '.tsv',
  '.xml',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function extOf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx < 0 ? '' : path.slice(idx).toLowerCase();
}

export function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extOf(path));
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(path));
}

/** Format file size for display. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Validate a skill name on the client side (mirrors core/skills/frontmatter.ts). */
export function validateSkillNameClient(name: string): string | null {
  if (!name) return 'Name is required';
  if (name.length > 64) return 'Name must be 64 characters or fewer';
  if (!/^[a-z0-9-]+$/.test(name)) {
    return 'Use only lowercase letters, digits, and hyphens';
  }
  if (name === 'anthropic' || name === 'claude') {
    return `'${name}' is reserved`;
  }
  return null;
}
