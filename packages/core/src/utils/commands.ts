/**
 * Shared command utilities for markdown file discovery.
 */
import { readdir } from 'fs/promises';
import { join, basename } from 'path';

/**
 * Recursively find all .md files in a directory and its subdirectories.
 * Skips hidden directories and node_modules.
 *
 * `maxDepth` caps how many folders deep the walk descends. Default is
 * `Infinity` (no cap) so callers that copy arbitrary subtrees (e.g.
 * `packages/core/src/handlers/clone.ts`) preserve existing behavior.
 */
export async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = '',
  options?: { maxDepth?: number }
): Promise<{ commandName: string; relativePath: string }[]> {
  const maxDepth = options?.maxDepth ?? Infinity;
  const currentDepth = relativePath ? relativePath.split(/[/\\]/).filter(Boolean).length : 0;
  const results: { commandName: string; relativePath: string }[] = [];
  const fullPath = join(rootPath, relativePath);

  const entries = await readdir(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      if (currentDepth >= maxDepth) continue;
      const subResults = await findMarkdownFilesRecursive(
        rootPath,
        join(relativePath, entry.name),
        options
      );
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push({
        commandName: basename(entry.name, '.md'),
        relativePath: join(relativePath, entry.name),
      });
    }
  }

  return results;
}
