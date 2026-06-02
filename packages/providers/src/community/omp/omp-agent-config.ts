import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Parse `modelRoles.default` from OMP agent config YAML text. */
export function parseOmpAgentDefaultModelFromYaml(raw: string): string | undefined {
  const match = /modelRoles:[\s\S]*?default:\s*(\S+)/.exec(raw);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Read `modelRoles.default` from ~/.omp/agent/config.yml when Archon has no
 * workflow- or assistant-level model.
 */
export async function readOmpAgentDefaultModel(): Promise<string | undefined> {
  const configPath = join(homedir(), '.omp', 'agent', 'config.yml');
  try {
    const raw = await readFile(configPath, 'utf8');
    return parseOmpAgentDefaultModelFromYaml(raw);
  } catch {
    return undefined;
  }
}
