/**
 * Token estimation + context-source classification primitives for the
 * Context Budget Visualizer (observability).
 *
 * All functions are pure and deterministic — no model, no I/O. The estimator is a
 * deliberately coarse chars/4 heuristic, labeled "estimate" everywhere it surfaces
 * (model-exact tokenization is a later enhancement, PRD §7.1). Phase 1 only defines
 * these primitives; nothing in the execution path calls them yet.
 */

/**
 * Approximate the token count of arbitrary text using the chars/4 heuristic.
 * Deterministic. Returns 0 for empty input.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Source type of a tool the agent invoked during a run (L3 dynamic reads). */
export type ToolSourceType = 'file-read' | 'grep' | 'bash' | 'other';

/**
 * Map a tool name (from a `tool_called` event) to its context source type.
 * `Read`/`Edit` → `file-read`, `Grep` → `grep`, `Bash` → `bash`, everything
 * else → `other`. Matching is case-insensitive on the tool's base name.
 */
export function classifyToolSource(toolName: string): ToolSourceType {
  const name = toolName.trim().toLowerCase();
  switch (name) {
    case 'read':
    case 'edit':
    case 'write':
    case 'multiedit':
      return 'file-read';
    case 'grep':
      return 'grep';
    case 'bash':
      return 'bash';
    default:
      return 'other';
  }
}

/**
 * Hard-coded low-value path patterns for MVP (PRD decision D2): lockfiles and
 * common generated/dependency directories. Making these user-configurable is
 * deferred to a later phase.
 */
const LOW_VALUE_DIR_SEGMENTS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
];

/**
 * True when a path looks low-value for an AI read (lockfiles, generated/dependency
 * dirs). Matches `*.lock`, `*-lock.json`, `package-lock.json`, and any path that
 * crosses a known generated/dependency directory segment. Case-insensitive;
 * tolerates both `/` and `\` separators.
 */
export function isLowValuePath(path: string): boolean {
  const normalized = path.trim().toLowerCase().replace(/\\/g, '/');
  if (normalized.length === 0) return false;

  const basename = normalized.split('/').pop() ?? normalized;

  // Lockfiles: *.lock, *-lock.json (covers package-lock.json), and well-known names.
  if (basename.endsWith('.lock')) return true;
  if (basename.endsWith('-lock.json')) return true;
  if (basename === 'package-lock.json') return true;
  if (basename === 'yarn.lock') return true;
  if (basename === 'bun.lockb') return true;

  // Generated / dependency directories anywhere in the path.
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (LOW_VALUE_DIR_SEGMENTS.includes(segment)) return true;
  }

  return false;
}
