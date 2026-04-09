/**
 * Shared codebase lookup utilities.
 * Extracted to prevent divergence between orchestrator-agent.ts and workflow-tool.ts.
 */
import type { Codebase } from '../types';

/**
 * Find a codebase by exact name or by last path segment (e.g., "repo" matches "owner/repo").
 * Case-insensitive.
 */
export function findCodebaseByName(
  codebases: readonly Codebase[],
  projectName: string
): Codebase | undefined {
  const projectLower = projectName.toLowerCase();
  return codebases.find(c => {
    const nameLower = c.name.toLowerCase();
    return nameLower === projectLower || nameLower.endsWith(`/${projectLower}`);
  });
}
