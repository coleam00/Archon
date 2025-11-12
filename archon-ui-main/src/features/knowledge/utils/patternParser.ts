/**
 * URL Pattern Parser Utility
 *
 * Parses unified glob pattern strings into separate include and exclude arrays.
 * Used for filtering links during knowledge crawling.
 *
 * Pattern format:
 * - Comma-separated patterns
 * - Patterns starting with "!" are exclusions
 * - Other patterns are inclusions
 */

export interface ParsedPatterns {
  include: string[];
  exclude: string[];
}

/**
 * Parse a unified glob pattern string into separate include and exclude arrays.
 * @param patterns - Comma-separated pattern string
 * @returns Object with include and exclude pattern arrays
 */
export function parseUrlPatterns(patterns: string): ParsedPatterns {
  const include: string[] = [];
  const exclude: string[] = [];

  patterns
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .forEach((pattern) => {
      if (pattern.startsWith("!")) {
        // Exclude pattern - remove the ! prefix
        exclude.push(pattern.substring(1).trim());
      } else {
        // Include pattern
        include.push(pattern);
      }
    });

  return { include, exclude };
}
