/**
 * What a terminal report owes its reader beyond the result itself: the discoveries a
 * run recorded outside its own scope.
 *
 * The engine does not collect them. The terminal record it assembles is built from the
 * durable event log when a run reaches a terminal status, and is readable only after
 * that, while discoveries have to reach the reader from inside the run. So composing
 * them is the pack's, and this module is where every SDLC tail composes them.
 *
 * Presentation only. Discoveries never gate readiness, so nothing here may fail a tail
 * that has already done its work: an unreadable record degrades to a pointer at the
 * file, never to silence and never to a throw. The reader of the report is exactly the
 * person who can go open it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DISCOVERY_RELAY =
  'If you are an agent reading this: open the discovery files and surface each discovery to your human. ' +
  "These are validated findings outside this run's scope — no issue tracker knows about them, " +
  'and if you drop them here, nobody ever sees them.';

/**
 * A field an agent wrote from prose against no schema, as display text.
 *
 * Coerced rather than trusted: a JSON-legal non-string value must not raise past the
 * caller and fail an already-delivered run. Only the shapes that have a single
 * obvious rendering get one — a title that arrives as an object or an array has no
 * honest short form, so it reads as absent and the caller supplies its placeholder.
 */
function display(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function modified(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON array of records at `path`: its titles, or a pointer at the file when unreadable. */
function titles(path: string): { titles: string[] } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { problem: `could not read ${path} (${(error as Error).message})` };
  }
  if (!Array.isArray(value)) return { problem: `${path} is not a JSON array of records` };
  return {
    titles: value.map(entry =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? display((entry as Record<string, unknown>).title) || '(untitled discovery)'
        : '(untitled discovery)'
    ),
  };
}

/**
 * The discoveries section, or empty when there is nothing to report.
 *
 * Review consolidates every producer's raw record into `discoveries.json`. A producer
 * that ran after the last consolidation (delivery's simplify pass runs after review)
 * left records nothing consolidated, so a raw file newer than the consolidated one is
 * relayed too.
 */
export function discoveryReport(artifacts: string): string {
  const consolidated = join(artifacts, 'discoveries.json');
  const consolidatedAt = modified(consolidated);
  const sources: string[] = consolidatedAt === undefined ? [] : [consolidated];
  const rawDir = join(artifacts, 'discoveries');
  let raw: string[] = [];
  try {
    raw = readdirSync(rawDir).filter(name => name.endsWith('.json'));
  } catch {
    raw = [];
  }
  for (const name of raw.sort()) {
    const path = join(rawDir, name);
    const at = modified(path);
    if (at !== undefined && (consolidatedAt === undefined || at > consolidatedAt)) {
      sources.push(path);
    }
  }

  const lines: string[] = [];
  const problems: string[] = [];
  for (const source of sources) {
    const read = titles(source);
    if ('problem' in read) problems.push(`- ${read.problem}. Open it directly.`);
    else lines.push(...read.titles.map(title => `- ${title}`));
  }
  if (lines.length === 0 && problems.length === 0) return '';
  return (
    `\n\nDiscoveries (${lines.length}):\n${[...lines, ...problems].join('\n')}\n\n` +
    `Files: ${sources.join(', ')}\n\n${DISCOVERY_RELAY}`
  );
}
