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
