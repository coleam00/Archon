/**
 * Agent persona registry for Cauldron workflows.
 *
 * Loads .archon/agents/*.md files at startup. Each file has YAML frontmatter
 * (name, model, tools, description) plus a Markdown body that becomes the
 * system prompt injected into matching workflow nodes.
 *
 * Validation is fail-closed: any malformed agent file causes the registry load
 * to throw, preventing workflows from firing with a broken persona set.
 */

import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { createLogger } from '@archon/paths';
import { KNOWN_TOOLS } from './tools';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.agent-registry');
  return cachedLog;
}

/** Structured error codes for agent file validation failures */
export type AgentErrorCode =
  | 'agent_missing_name'
  | 'agent_name_filename_mismatch'
  | 'agent_missing_model'
  | 'agent_invalid_model'
  | 'agent_invalid_tool'
  | 'agent_empty_prompt'
  | 'agent_not_found'
  | 'agent_file_read_error';

export class AgentRegistryError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    public readonly agentFile: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentRegistryError';
  }
}

/** Valid model aliases for agent frontmatter.
 *  These are the Claude model shorthands supported by the Archon harness. */
export const KNOWN_MODEL_ALIASES: ReadonlySet<string> = new Set([
  'sonnet',
  'opus',
  'haiku',
  'opus[1m]',
  'sonnet[1m]',
  // Full model IDs are also accepted
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

/** Parsed frontmatter from an agent .md file */
export interface AgentFrontmatter {
  name: string;
  model: string;
  tools?: string[];
  description?: string;
}

/** A fully loaded and validated agent persona */
export interface AgentPersona {
  name: string;
  model: string;
  tools?: string[];
  description?: string;
  systemPrompt: string;
}

/** In-memory registry mapping agent name → persona */
export type AgentRegistry = Map<string, AgentPersona>;

/**
 * Parse YAML-style frontmatter delimited by `---` lines.
 * Returns `{ frontmatter, body }` where body is everything after the closing `---`.
 *
 * This is a minimal parser that handles only the field types used in agent files:
 * strings, arrays of strings, and optional fields. It does NOT support nested
 * objects. YAML quirks like anchors, aliases, or multi-line scalars are not
 * supported and will be treated as plain strings.
 *
 * Returns `null` if the file does not start with `---\n`.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;

  const afterOpening = content.startsWith('---\r\n') ? content.slice(5) : content.slice(4);
  const closingIdx = afterOpening.search(/^---(\r?\n|$)/m);
  if (closingIdx === -1) return null;

  const fmText = afterOpening.slice(0, closingIdx);
  const bodyStart = closingIdx + afterOpening.slice(closingIdx).match(/^---(\r?\n|$)/m)![0].length;
  const body = afterOpening.slice(bodyStart).trim();

  const frontmatter: Record<string, unknown> = {};
  let i = 0;
  const lines = fmText.split(/\r?\n/);

  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.startsWith('#')) { i++; continue; }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '' || rest === null) {
      // Could be a block sequence on next lines
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i]?.startsWith('  - ')) {
        items.push((lines[i] ?? '').slice(4).trim());
        i++;
      }
      if (items.length > 0) {
        frontmatter[key] = items;
      }
      continue;
    }

    // Inline sequence: [a, b, c]
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1);
      frontmatter[key] = inner
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      i++;
      continue;
    }

    // Plain scalar — strip optional quotes
    frontmatter[key] = rest.replace(/^["']|["']$/g, '');
    i++;
  }

  return { frontmatter, body };
}

/**
 * Load and validate a single agent .md file.
 * Throws `AgentRegistryError` for any validation failure.
 */
export async function loadAgentFile(filePath: string): Promise<AgentPersona> {
  const filename = basename(filePath, '.md');
  let content: string;

  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new AgentRegistryError(
      'agent_file_read_error',
      filePath,
      `Cannot read agent file '${filePath}': ${(err as Error).message}`
    );
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new AgentRegistryError(
      'agent_missing_name',
      filePath,
      `Agent file '${filePath}' must start with YAML frontmatter (--- ... ---)`
    );
  }

  const { frontmatter, body } = parsed;

  // --- name validation ---
  if (typeof frontmatter.name !== 'string' || !frontmatter.name) {
    throw new AgentRegistryError(
      'agent_missing_name',
      filePath,
      `Agent file '${filePath}' is missing required frontmatter field 'name:' [agent_missing_name]`
    );
  }

  if (frontmatter.name !== filename) {
    throw new AgentRegistryError(
      'agent_name_filename_mismatch',
      filePath,
      `Agent file '${filePath}': frontmatter 'name: ${frontmatter.name}' does not match filename '${filename}' [agent_name_filename_mismatch]`
    );
  }

  // --- model validation ---
  if (typeof frontmatter.model !== 'string' || !frontmatter.model) {
    throw new AgentRegistryError(
      'agent_missing_model',
      filePath,
      `Agent file '${filePath}' is missing required frontmatter field 'model:' [agent_missing_model]`
    );
  }

  if (!KNOWN_MODEL_ALIASES.has(frontmatter.model)) {
    throw new AgentRegistryError(
      'agent_invalid_model',
      filePath,
      `Agent file '${filePath}': unknown model alias '${frontmatter.model}'. ` +
        `Valid aliases: ${[...KNOWN_MODEL_ALIASES].sort().join(', ')} [agent_invalid_model]`
    );
  }

  // --- tools validation ---
  if (frontmatter.tools !== undefined) {
    if (!Array.isArray(frontmatter.tools)) {
      throw new AgentRegistryError(
        'agent_invalid_tool',
        filePath,
        `Agent file '${filePath}': 'tools:' must be a list of tool names [agent_invalid_tool]`
      );
    }
    for (const tool of frontmatter.tools as string[]) {
      if (!KNOWN_TOOLS.has(tool)) {
        throw new AgentRegistryError(
          'agent_invalid_tool',
          filePath,
          `Agent file '${filePath}': unknown tool '${tool}'. ` +
            `Known tools: ${[...KNOWN_TOOLS].sort().join(', ')} [agent_invalid_tool]`
        );
      }
    }
  }

  // --- body (system prompt) validation ---
  if (!body) {
    throw new AgentRegistryError(
      'agent_empty_prompt',
      filePath,
      `Agent file '${filePath}' has no system prompt body (content after frontmatter is empty) [agent_empty_prompt]`
    );
  }

  const persona: AgentPersona = {
    name: frontmatter.name as string,
    model: frontmatter.model as string,
    systemPrompt: body,
  };

  if (Array.isArray(frontmatter.tools) && (frontmatter.tools as string[]).length > 0) {
    persona.tools = frontmatter.tools as string[];
  }
  if (typeof frontmatter.description === 'string' && frontmatter.description) {
    persona.description = frontmatter.description;
  }

  return persona;
}

/**
 * Load all agent persona files from a directory (non-recursive, *.md only).
 * Returns the populated registry.
 *
 * Throws `AgentRegistryError` for the first invalid file encountered — the
 * registry is all-or-nothing: a single malformed file prevents startup.
 *
 * Returns an empty registry if the directory does not exist (no agents configured).
 */
export async function loadAgentRegistry(agentsDir: string): Promise<AgentRegistry> {
  const registry: AgentRegistry = new Map();

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      // No agents directory — return empty registry (agents are optional)
      return registry;
    }
    throw new AgentRegistryError(
      'agent_file_read_error',
      agentsDir,
      `Cannot read agents directory '${agentsDir}': ${nodeErr.message}`
    );
  }

  const mdFiles = entries.filter(e => e.endsWith('.md')).sort();

  for (const filename of mdFiles) {
    const filePath = join(agentsDir, filename);
    const persona = await loadAgentFile(filePath);
    registry.set(persona.name, persona);
    getLog().info(
      { name: persona.name, model: persona.model, tools: persona.tools },
      'agent.loaded'
    );
  }

  getLog().info({ count: registry.size }, 'agent.registry_loaded');
  return registry;
}

/**
 * Resolve an agent name to its persona from the registry.
 * Returns `undefined` if the registry is empty (no agents dir configured).
 * Throws `AgentRegistryError` with code `agent_not_found` if the registry was
 * loaded but the name is absent.
 */
export function resolveAgent(
  name: string,
  registry: AgentRegistry
): AgentPersona | undefined {
  if (registry.size === 0) return undefined;

  const persona = registry.get(name);
  if (!persona) {
    throw new AgentRegistryError(
      'agent_not_found',
      name,
      `Agent '${name}' not found in registry. Available: ${[...registry.keys()].sort().join(', ')} [agent_not_found]`
    );
  }
  return persona;
}
