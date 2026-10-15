import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type McpPathResolution =
  | { kind: 'found'; path: string; content: string; attemptedPaths: string[] }
  | { kind: 'missing'; attemptedPaths: [string, ...string[]] }
  | { kind: 'read_error'; path: string; error: unknown; attemptedPaths: string[] };

export async function resolveMcpPath(
  declaration: string,
  cwd: string,
  homeYamlDirectory?: string
): Promise<McpPathResolution> {
  const first = resolve(cwd, declaration);
  const candidates = new Set([first]);
  if (!isAbsolute(declaration) && homeYamlDirectory !== undefined) {
    candidates.add(resolve(homeYamlDirectory, declaration));
  }
  const attemptedPaths: [string, ...string[]] = [first];
  for (const path of candidates) {
    if (path !== first) attemptedPaths.push(path);
    try {
      return { kind: 'found', path, content: await readFile(path, 'utf-8'), attemptedPaths };
    } catch (error) {
      // Only absence permits fallback; an unreadable checkout config still owns the path.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { kind: 'read_error', path, error, attemptedPaths };
      }
    }
  }
  return { kind: 'missing', attemptedPaths };
}

export function missingMcpConfigMessage(declaration: string, attemptedPaths: string[]): string {
  return `MCP config file not found: '${declaration}'. Tried: ${attemptedPaths.join(', ')}`;
}
