/**
 * Project README reader for orchestrator routing.
 *
 * When a chat message references a JIRA ticket on an unscoped conversation, the
 * orchestrator needs more than project names/repo URLs to map the ticket to the
 * right project. Reading the top of each registered project's README gives the
 * AI a human-written summary of what each project IS, so it can match a ticket's
 * subject/description to the most likely project on its own.
 *
 * Strictly best-effort: a missing or unreadable README yields `undefined` for
 * that project and routing degrades to repo-URL/name matching.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';
import { toError } from '../utils/error';
import type { Codebase } from '../schemas/codebase';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.project-readme');
  return cachedLog;
}

/** README filenames to probe, in priority order. */
const README_CANDIDATES = ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];

/** Max characters of README content to surface per project (keeps prompts lean). */
const MAX_README_CHARS = 800;

/**
 * Read a short snippet from the first README found in `cwd`, or undefined.
 * Markdown badges/HTML comment lines are dropped from the head so the snippet
 * leads with prose rather than shield images.
 */
export async function readProjectReadmeSnippet(cwd: string): Promise<string | undefined> {
  for (const candidate of README_CANDIDATES) {
    try {
      const raw = await readFile(join(cwd, candidate), 'utf8');
      const cleaned = raw
        .split('\n')
        .filter(line => {
          const t = line.trim();
          // Drop badge-only lines and HTML comments — noise for matching.
          if (t.startsWith('<!--') || t.startsWith('[![') || t.startsWith('![')) return false;
          return true;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!cleaned) return undefined;
      return cleaned.length > MAX_README_CHARS
        ? cleaned.slice(0, MAX_README_CHARS).trimEnd() + '\n…'
        : cleaned;
    } catch {
      // Try the next candidate filename.
      continue;
    }
  }
  return undefined;
}

/**
 * Read README snippets for a set of codebases, keyed by codebase id. Projects
 * without a readable README are simply absent from the map. Reads run
 * concurrently; failures are logged at debug and never throw.
 */
export async function readProjectReadmes(
  codebases: readonly Codebase[]
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    codebases.map(async (c): Promise<[string, string] | undefined> => {
      try {
        const snippet = await readProjectReadmeSnippet(c.default_cwd);
        return snippet ? [c.id, snippet] : undefined;
      } catch (error) {
        getLog().debug({ err: toError(error), codebaseId: c.id }, 'project_readme.read_failed');
        return undefined;
      }
    })
  );
  return new Map(entries.filter((e): e is [string, string] => e !== undefined));
}
