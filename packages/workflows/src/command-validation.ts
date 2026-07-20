/**
 * Validates a command name to prevent path traversal and enforce naming conventions.
 * Extracted to break the executor ↔ dag-executor circular dependency.
 */
export function isValidCommandName(name: string): boolean {
  // Reject names with path separators or parent directory references
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  // Reject empty names or names starting with .
  if (!name || name.startsWith('.')) {
    return false;
  }
  return true;
}

/**
 * The maximum subfolder depth workflow discovery descends to. A value of 1
 * means a workflow may be namespaced one folder deep (e.g. `triage/review`).
 *
 * Shared with workflow-discovery.ts so discovery depth and the name validator can't drift.
 */
export const MAX_DISCOVERY_DEPTH = 1;

/**
 * Validates a workflow name. Unlike a bare command name, a workflow may be
 * namespaced up to `MAX_DISCOVERY_DEPTH` subfolders deep (e.g. `triage/review`):
 * workflows are discovered at most that many folders deep, so the number of
 * `/`-separated segments is capped at `MAX_DISCOVERY_DEPTH + 1`. Each segment
 * must itself be a valid command name, which keeps the path-traversal protection
 * intact (no `..`, no `\`, no leading dot, no empty segment — so leading,
 * trailing, and double slashes are all rejected).
 */
export function isValidWorkflowName(name: string): boolean {
  if (!name) {
    return false;
  }
  const segments = name.split('/');
  // At most MAX_DISCOVERY_DEPTH levels of namespacing.
  if (segments.length > MAX_DISCOVERY_DEPTH + 1) {
    return false;
  }
  // Every segment must be a valid, slash-free command name.
  return segments.every(isValidCommandName);
}
