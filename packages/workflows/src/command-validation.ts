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
 * Validates a workflow name. Unlike a bare command name, a workflow may be
 * namespaced one subfolder deep (e.g. `triage/review`): workflows are discovered
 * at most `MAX_DISCOVERY_DEPTH` (1) folders deep, so a single `/` is the only
 * nesting allowed. Each segment must itself be a valid command name, which keeps
 * the path-traversal protection intact (no `..`, no `\`, no leading dot, no
 * empty segment — so leading, trailing, and double slashes are all rejected).
 *
 * The HTTP launch and read routes resolve workflows by name the same way the CLI
 * does on disk; using this in place of `isValidCommandName` lets namespaced
 * workflows be launched and fetched over the API instead of only via the CLI.
 */
export function isValidWorkflowName(name: string): boolean {
  if (!name) {
    return false;
  }
  const segments = name.split('/');
  // At most one level of namespacing (matches MAX_DISCOVERY_DEPTH = 1).
  if (segments.length > 2) {
    return false;
  }
  // Every segment must be a valid, slash-free command name.
  return segments.every(isValidCommandName);
}
